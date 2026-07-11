import {
  Injectable, Logger, NotFoundException, BadRequestException, ConflictException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Decimal } from 'decimal.js';
import { createHash } from 'crypto';
import { AccountType, LoanStatus, InterestType, JournalEntryType, TransactionStatus, TransactionType } from '@prisma/client';
import { v4 as uuidv4 } from 'uuid';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { MpesaService } from '../mpesa/mpesa.service';
import { LedgerService } from '../accounting/ledger.service';
import { IdempotencyService } from '../../common/services/idempotency.service';
import { MemberDepositDto, DepositPurpose } from '../mpesa/dto/deposit-request.dto';
import { maskPhone } from '../mpesa/utils/mpesa.utils';
import { MpesaTriggerSource } from '@prisma/client';
import { LoansService } from '../loans/loans.service';
import { StorageService } from '../storage/storage.service';
import { AccountsService } from '../accounts/accounts.service';
import { GuarantorResponseDto } from '../loans/dto/guarantor-response.dto';
import { MemberLoanApplyDto } from './dto/member-loan-apply.dto';
import { UploadUrlResponseDto } from './dto/upload-url.dto';
import {
  ProfileImageUploadUrlRequestDto,
  ProfileImageUploadUrlResponseDto,
  ProfileImageUrlResponseDto,
} from './dto/profile-image.dto';
import { QUEUE_NAMES, MpesaDisbursementJobPayload } from '../queue/queue.constants';
import { InternalTransferDto } from './dto/internal-transfer.dto';

const PROFILE_IMAGE_CONTENT_TYPES: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

/**
 * Member Portal Service
 *
 * All methods are scoped to the authenticated member's profile.
 * Tenant isolation enforced by passing tenantId from the JWT throughout.
 */
@Injectable()
export class MemberPortalService {
  private readonly logger = new Logger(MemberPortalService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly mpesaService: MpesaService,
    private readonly loansService: LoansService,
    private readonly storage: StorageService,
    private readonly accountsService: AccountsService,
    private readonly ledger: LedgerService,
    private readonly idempotency: IdempotencyService,
    @InjectQueue(QUEUE_NAMES.MPESA_DISBURSEMENT)
    private readonly disbursementQueue: Queue<MpesaDisbursementJobPayload>,
  ) {}

  // ─── DASHBOARD ────────────────────────────────────────────────

  /**
   * Member dashboard snapshot:
   *  - FOSA & BOSA balances
   *  - Active loans summary
   *  - Recent 5 transactions
   *  - Pending guarantor requests
   */
  async getDashboard(userId: string, tenantId: string) {
    const member = await this.resolveMember(userId, tenantId);

    const [accounts, activeLoans, recentTransactions, pendingGuarantorRequests] =
      await this.prisma.$transaction([
        this.prisma.account.findMany({
          where: { memberId: member.id, tenantId, isActive: true },
          select: { id: true, accountNumber: true, accountType: true, balance: true },
        }),
        this.prisma.loan.findMany({
          where: { memberId: member.id, tenantId, status: LoanStatus.ACTIVE },
          select: {
            id: true,
            loanNumber: true,
            principalAmount: true,
            outstandingBalance: true,
            monthlyInstalment: true,
            dueDate: true,
          },
        }),
        this.prisma.transaction.findMany({
          where: { tenantId, account: { memberId: member.id } },
          orderBy: { createdAt: 'desc' },
          take: 5,
          select: {
            id: true,
            type: true,
            amount: true,
            balanceAfter: true,
            description: true,
            createdAt: true,
            account: { select: { accountType: true } },
          },
        }),
        this.prisma.loanGuarantor.findMany({
          where: { memberId: member.id, tenantId, status: 'PENDING' },
          include: {
            loan: {
              select: {
                loanNumber: true,
                principalAmount: true,
                purpose: true,
                member: {
                  select: {
                    user: { select: { firstName: true, lastName: true } },
                  },
                },
              },
            },
          },
        }),
      ]);

    const fosaAccount = accounts.find((a) => a.accountType === 'FOSA');
    const bosaAccount = accounts.find((a) => a.accountType === 'BOSA');

    return {
      member: {
        id: member.id,
        memberNumber: member.memberNumber,
        name: `${member.user.firstName} ${member.user.lastName}`,
        email: member.user.email,
      },
      balances: {
        fosa: fosaAccount ? new Decimal(fosaAccount.balance.toString()).toNumber() : 0,
        bosa: bosaAccount ? new Decimal(bosaAccount.balance.toString()).toNumber() : 0,
        fosaAccountId: fosaAccount?.id ?? null,
        bosaAccountId: bosaAccount?.id ?? null,
      },
      activeLoans: activeLoans.map((l) => ({
        ...l,
        principalAmount: new Decimal(l.principalAmount.toString()).toNumber(),
        outstandingBalance: new Decimal(l.outstandingBalance.toString()).toNumber(),
        monthlyInstalment: new Decimal(l.monthlyInstalment.toString()).toNumber(),
      })),
      recentTransactions,
      pendingGuarantorRequests: pendingGuarantorRequests.map((g) => ({
        guarantorId: g.id,
        loanId: g.loanId,
        loanNumber: g.loan.loanNumber,
        applicantName: `${g.loan.member.user.firstName} ${g.loan.member.user.lastName}`,
        loanAmount: new Decimal(g.loan.principalAmount.toString()).toNumber(),
        guaranteedAmount: new Decimal(g.guaranteedAmount.toString()).toNumber(),
        purpose: g.loan.purpose,
        invitedAt: g.invitedAt,
      })),
    };
  }

  // ─── FOSA STATEMENT ──────────────────────────────────────────

  async getFosaStatement(
    userId: string,
    tenantId: string,
    page: number,
    limit: number,
    from?: string,
    to?: string,
  ) {
    const member = await this.resolveMember(userId, tenantId);

    const fosaAccount = await this.prisma.account.findFirst({
      where: { memberId: member.id, tenantId, accountType: 'FOSA', isActive: true },
      select: { id: true, accountNumber: true, balance: true },
    });
    if (!fosaAccount) throw new NotFoundException('No active FOSA account found');

    const safePage = Math.max(1, page);
    const safeLimit = Math.min(100, Math.max(1, limit));
    const skip = (safePage - 1) * safeLimit;

    const dateFilter: { gte?: Date; lte?: Date } = {};
    if (from) dateFilter.gte = new Date(from);
    if (to) {
      const toDate = new Date(to);
      toDate.setHours(23, 59, 59, 999);
      dateFilter.lte = toDate;
    }

    const where = {
      accountId: fosaAccount.id,
      tenantId,
      ...(Object.keys(dateFilter).length > 0 && { createdAt: dateFilter }),
    };

    const [transactions, total] = await this.prisma.$transaction([
      this.prisma.transaction.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: safeLimit,
        select: {
          id: true,
          type: true,
          status: true,
          amount: true,
          balanceBefore: true,
          balanceAfter: true,
          reference: true,
          description: true,
          createdAt: true,
        },
      }),
      this.prisma.transaction.count({ where }),
    ]);

    return {
      account: {
        accountNumber: fosaAccount.accountNumber,
        currentBalance: new Decimal(fosaAccount.balance.toString()).toNumber(),
      },
      data: transactions.map((t) => ({
        ...t,
        amount: new Decimal(t.amount.toString()).toNumber(),
        balanceBefore: new Decimal(t.balanceBefore.toString()).toNumber(),
        balanceAfter: new Decimal(t.balanceAfter.toString()).toNumber(),
      })),
      meta: {
        total,
        page: safePage,
        limit: safeLimit,
        totalPages: Math.ceil(total / safeLimit),
      },
    };
  }

  // ─── SELF-APPLY FOR LOAN ─────────────────────────────────────

  /**
   * Member applies for their own loan.
   * Validates member balance thresholds per business rules.
   */
  async applyForLoan(
    userId: string,
    dto: MemberLoanApplyDto,
    tenantId: string,
    ipAddress?: string,
  ) {
    const member = await this.resolveMember(userId, tenantId);

    const product = await this.prisma.loanProduct.findFirst({
      where: { id: dto.loanProductId, tenantId, isActive: true },
    });
    if (!product) throw new NotFoundException('Loan product not found or inactive');

    const principal = new Decimal(dto.principalAmount);

    // Business rule: amount <= product.maxLimit AND <= (fosaBalance * 3) + (bosaBalance * 1.5)
    const accounts = await this.prisma.account.findMany({
      where: { memberId: member.id, tenantId, isActive: true },
      select: { accountType: true, balance: true },
    });
    const fosaBalance = new Decimal(
      accounts.find((a) => a.accountType === 'FOSA')?.balance.toString() ?? '0',
    );
    const bosaBalance = new Decimal(
      accounts.find((a) => a.accountType === 'BOSA')?.balance.toString() ?? '0',
    );
    const maxEligible = fosaBalance.times(3).plus(bosaBalance.times(1.5));

    if (principal.greaterThan(maxEligible)) {
      throw new BadRequestException(
        `Loan amount KES ${principal.toNumber()} exceeds your eligible limit of KES ${maxEligible.toFixed(2)}`,
      );
    }

    // Delegate to LoansService.apply — pass memberId from member profile
    return this.loansService.apply(
      {
        memberId: member.id,
        loanProductId: dto.loanProductId,
        principalAmount: dto.principalAmount,
        tenureMonths: dto.tenureMonths,
        purpose: dto.purpose,
        notes: dto.notes,
      },
      tenantId,
      userId,
      ipAddress,
    );
  }

  // ─── GUARANTOR RESPONSE ──────────────────────────────────────

  async respondToGuarantor(
    userId: string,
    loanId: string,
    dto: GuarantorResponseDto,
    tenantId: string,
    ipAddress?: string,
  ) {
    const member = await this.resolveMember(userId, tenantId);
    return this.loansService.respondAsGuarantor(loanId, member.id, dto, tenantId, ipAddress);
  }

  // ─── MPESA STK PUSH DEPOSIT ──────────────────────────────────

  async initiateDeposit(
    userId: string,
    phone: string,
    amount: number,
    tenantId: string,
    ipAddress?: string,
    idempotencyKey?: string,
  ) {
    const member = await this.resolveMember(userId, tenantId);

    const fosaAccount = await this.prisma.account.findFirst({
      where: { memberId: member.id, tenantId, accountType: 'FOSA', isActive: true },
      select: { id: true, accountNumber: true },
    });
    if (!fosaAccount) throw new NotFoundException('No active FOSA account found for deposit');

    await this.audit.create({
      tenantId,
      userId,
      action: 'MPESA.STK_INITIATED',
      resource: 'MpesaTransaction',
      metadata: { amount, accountNumber: fosaAccount.accountNumber },
      ipAddress,
    }).catch((e: unknown) => this.logger.error('Audit write failed', e));

    const depositDto: MemberDepositDto = {
      phoneNumber: phone,
      amount,
      purpose: DepositPurpose.SAVINGS,
      accountRef: fosaAccount.accountNumber,
    };

    return this.mpesaService.initiateDeposit(
      depositDto,
      tenantId,
      userId,
      userId,
      MpesaTriggerSource.MEMBER,
      idempotencyKey,
    );
  }

  // ─── MPESA FOSA WITHDRAWAL ───────────────────────────────────

  async withdrawMpesa(
    userId: string,
    phone: string,
    amount: number,
    tenantId: string,
    ipAddress?: string,
    idempotencyKey?: string,
  ) {
    if (!idempotencyKey?.trim()) {
      throw new BadRequestException('IDEMPOTENCY_KEY_REQUIRED');
    }
    const member = await this.resolveMember(userId, tenantId);

    // Redis-layer idempotency (mirrors MpesaService.initiateDeposit / GuarantorResponseService):
    // guards the whole operation, not just the ledger post below, and lets a replayed
    // request with an IDENTICAL payload return the original response without re-running
    // any of the account lookups or queue enqueue. A replay with the SAME key but a
    // DIFFERENT payload (amount/phone) is rejected outright — postEntry()'s reference-only
    // dedup can't tell those apart on its own, since the reference never encodes amount.
    const idemKey = `mpesa:withdraw:${tenantId}:${member.id}:${idempotencyKey.trim()}`;
    const payloadHash = createHash('sha256')
      .update(JSON.stringify({ phone, amount }))
      .digest('hex');

    const idem = await this.idempotency.checkAndReserve(idemKey, tenantId, 24 * 60 * 60);
    if (idem.status === 'COMPLETED') {
      const cached = idem.result as { payloadHash: string; response: { message: string; transactionId: string } };
      if (cached.payloadHash !== payloadHash) {
        throw new BadRequestException(
          'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD: this key was already used for a different amount/phone',
        );
      }
      return cached.response;
    }
    if (idem.status === 'PROCESSING') {
      throw new ConflictException('Withdrawal request is already processing');
    }

    try {
      const response = await this.executeWithdrawMpesa(member.id, userId, phone, amount, tenantId, ipAddress, idempotencyKey.trim());
      await this.idempotency.complete(idemKey, tenantId, { payloadHash, response }, 24 * 60 * 60);
      return response;
    } catch (error) {
      await this.idempotency.release(idemKey, tenantId);
      throw error;
    }
  }

  private async executeWithdrawMpesa(
    memberId: string,
    userId: string,
    phone: string,
    amount: number,
    tenantId: string,
    ipAddress: string | undefined,
    idempotencyKey: string,
  ): Promise<{ message: string; transactionId: string }> {
    // Hardcode withdrawal fee or fetch from config
    const withdrawalFee = new Decimal(0); // Add logic to calculate fee if needed
    const requestedAmount = new Decimal(amount);
    const totalDeduction = requestedAmount.plus(withdrawalFee);

    const result = await this.prisma.$transaction(async (tx) => {
      const fosaAccount = await tx.account.findFirst({
        where: { memberId, tenantId, accountType: 'FOSA', isActive: true },
        select: { id: true, balance: true, lockedBalance: true, frozenSavings: true, accountNumber: true },
      });

      if (!fosaAccount) {
        throw new NotFoundException('No active FOSA account found for withdrawal');
      }

      // lockedBalance/frozenSavings are not enforced by LedgerService.postEntry()'s
      // minimum-balance floor (it only knows about minimumBalance/allowsNegative), so
      // this withdrawal-specific check must stay here, ahead of the ledger post below.
      const availableBalance = new Decimal(fosaAccount.balance.toString()).minus(
        new Decimal(fosaAccount.lockedBalance.toString()).plus(new Decimal(fosaAccount.frozenSavings.toString()))
      );

      if (availableBalance.lessThan(totalDeduction)) {
        throw new BadRequestException('Insufficient FOSA available balance');
      }

      // Deterministic reference scoped to the caller-supplied idempotencyKey — never
      // Date.now() here. A wall-clock-based reference is not replay-safe: a client
      // retry milliseconds later would get a different reference and post (and debit)
      // a second time.
      const reference = `MPESA_WD-${tenantId}-${memberId}-${idempotencyKey}`;

      // Routed through LedgerService.postEntry() (debit the account's deposit-liability
      // GL code, credit CASH) instead of a manual Account.update() + Transaction.create()
      // — see Phase 1 audit: this used to bypass the GL entirely.
      const { transaction } = await this.ledger.postEntry({
        tenantId,
        reference,
        journalType: JournalEntryType.WITHDRAWAL,
        accountId: fosaAccount.id,
        amount: totalDeduction,
        direction: 'DEBIT',
        actorId: userId,
        description: `M-Pesa withdrawal to ${maskPhone(phone)}`,
        tx,
      });

      await this.audit.create({
        tenantId,
        actorId: userId,
        action: 'MPESA.WITHDRAW.INITIATED',
        entityType: 'Transaction',
        entityId: transaction.id,
        newValue: { amount, phone: maskPhone(phone), status: 'PROCESSING' },
        metadata: { accountId: fosaAccount.id },
        ipAddress,
      }).catch((e: unknown) => this.logger.error('Audit write failed', e));

      return {
        message: 'Withdrawal initiated successfully',
        transactionId: transaction.id,
        accountId: fosaAccount.id,
      };
    }, { isolationLevel: 'Serializable' });

    // Enqueue only after the database transaction commits to avoid ghost B2C payouts.
    await this.disbursementQueue.add(
      QUEUE_NAMES.MPESA_DISBURSEMENT,
      {
        referenceType: 'FOSA_WITHDRAWAL',
        referenceId: result.accountId,
        tenantId,
        phone,
        amount,
        triggeredBy: userId,
        sourceTransactionId: result.transactionId,
      },
      {
        jobId: `fosa-withdraw-${result.transactionId}`,
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: true,
        removeOnFail: { age: 86400, count: 50 },
      }
    );

    return {
      message: result.message,
      transactionId: result.transactionId,
    };
  }
  // ─── DOCUMENT UPLOAD ─────────────────────────────────────────

  /**
   * Return a pre-signed PUT URL the client uses to upload a document directly
   * to object storage. Scoped to the authenticated member's tenant + profile.
   */
  async requestUploadUrl(params: {
    tenantId: string;
    userId: string;
    fileName: string;
    contentType: string;
  }): Promise<UploadUrlResponseDto> {
    const member = await this.resolveMember(params.userId, params.tenantId);
    return this.storage.getUploadUrl({
      tenantId: params.tenantId,
      memberId: member.id,
      fileName: params.fileName,
      contentType: params.contentType,
    });
  }

  // ─── MEMBER LOANS LIST ───────────────────────────────────────

  /**
   * Returns paginated loans for the authenticated member.
   */
  async requestProfileImageUploadUrl(
    tenantId: string,
    userId: string,
    dto: ProfileImageUploadUrlRequestDto,
  ): Promise<ProfileImageUploadUrlResponseDto> {
    const ext = this.getProfileImageExtension(dto.fileName);
    const contentType = PROFILE_IMAGE_CONTENT_TYPES[ext];
    const fileKey = `avatars/${tenantId}/${userId}/profile.${ext}`;
    const signed = await this.storage.getUploadUrlForKey({
      objectKey: fileKey,
      contentType,
    });

    return {
      uploadUrl: signed.uploadUrl,
      fileKey,
      contentType,
      expiresIn: signed.expiresIn,
    };
  }

  async getProfileImageUrl(tenantId: string, userId: string): Promise<ProfileImageUrlResponseDto> {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, tenantId },
      select: { profileImageKey: true },
    });
    if (!user?.profileImageKey) {
      return { imageUrl: null, fileKey: null };
    }

    const expectedPrefix = `avatars/${tenantId}/${userId}/profile.`;
    if (!user.profileImageKey.startsWith(expectedPrefix)) {
      this.logger.warn(`Ignoring invalid profile image key for user=${userId} tenant=${tenantId}`);
      return { imageUrl: null, fileKey: null };
    }

    const imageUrl = await this.storage.getDownloadUrl(user.profileImageKey, 3600);
    return { imageUrl, fileKey: user.profileImageKey };
  }

  private getProfileImageExtension(fileName: string): keyof typeof PROFILE_IMAGE_CONTENT_TYPES {
    const match = fileName.trim().toLowerCase().match(/\.([a-z0-9]+)$/);
    const ext = match?.[1];
    if (!ext || !(ext in PROFILE_IMAGE_CONTENT_TYPES)) {
      throw new BadRequestException('Profile image must be a JPG, PNG, or WebP file');
    }
    return ext as keyof typeof PROFILE_IMAGE_CONTENT_TYPES;
  }

  async getMyLoans(
    userId: string,
    tenantId: string,
    page: number,
    limit: number,
    status?: string,
  ) {
    const member = await this.resolveMember(userId, tenantId);

    const safePage = Math.max(1, page);
    const safeLimit = Math.min(100, Math.max(1, limit));
    const skip = (safePage - 1) * safeLimit;

    const where = {
      memberId: member.id,
      tenantId,
      ...(status && { status: status as LoanStatus }),
    };

    const [loans, total] = await this.prisma.$transaction([
      this.prisma.loan.findMany({
        where,
        orderBy: { appliedAt: 'desc' },
        skip,
        take: safeLimit,
        include: {
          loanProduct: {
            select: {
              name: true,
              interestType: true,
              minGuarantors: true,
              maxGuarantors: true,
              guarantorCoverageRatio: true,
            },
          },
          guarantors: {
            select: {
              id: true,
              memberId: true,
              status: true,
              guaranteedAmount: true,
              invitedAt: true,
              respondedAt: true,
              member: {
                select: {
                  memberNumber: true,
                  user: { select: { firstName: true, lastName: true } },
                },
              },
            },
          },
        },
      }),
      this.prisma.loan.count({ where }),
    ]);

    return {
      data: loans.map((l) => ({
        ...l,
        principalAmount: l.principalAmount.toString(),
        interestRate: l.interestRate.toString(),
        processingFee: l.processingFee.toString(),
        monthlyInstalment: l.monthlyInstalment.toString(),
        outstandingBalance: l.outstandingBalance.toString(),
        totalRepaid: l.totalRepaid.toString(),
        guarantors: l.guarantors.map((g) => ({
          ...g,
          guaranteedAmount: g.guaranteedAmount.toString(),
        })),
      })),
      meta: {
        page: safePage,
        limit: safeLimit,
        total,
        totalPages: Math.ceil(total / safeLimit),
      },
    };
  }

  // ─── LOAN DETAIL ─────────────────────────────────────────────

  /**
   * Return full loan detail for a member's own loan.
   *
   * Ownership: loan.memberId must match the resolved memberId from JWT.
   * accruedInterest is stubbed at 0 until Tier 3 adds the schema column.
   * repaymentSchedule is generated analytically from loan metadata; actual
   * LoanRepayment rows will replace this stub in Tier 3.
   */
  async getLoanDetail(loanId: string, userId: string, tenantId: string) {
    const member = await this.resolveMember(userId, tenantId);

    const loan = await this.prisma.loan.findFirst({
      where: { id: loanId, tenantId, memberId: member.id },
      include: {
        loanProduct: { select: { name: true, interestType: true, interestRate: true } },
        guarantors: {
          select: {
            status: true,
            guaranteedAmount: true,
            member: {
              select: {
                memberNumber: true,
                user: { select: { firstName: true, lastName: true } },
              },
            },
          },
        },
      },
    });
    if (!loan) {
      throw new NotFoundException('Loan not found or does not belong to you');
    }

    // Last 5 transactions for this loan
    const recentTransactions = await this.prisma.transaction.findMany({
      where: { loanId, tenantId },
      orderBy: { createdAt: 'desc' },
      take: 5,
      select: {
        id: true,
        type: true,
        status: true,
        amount: true,
        balanceBefore: true,
        balanceAfter: true,
        reference: true,
        description: true,
        createdAt: true,
      },
    });

    const outstanding = new Decimal(loan.outstandingBalance.toString());
    const accruedInterest = new Decimal(loan.accruedInterest.toString());
    const totalAmountDue = outstanding.plus(accruedInterest).toNumber();

    // Fetch LoanRepayment schedule rows (generated at disburse time)
    const scheduleRows = await this.prisma.loanRepayment.findMany({
      where: { loanId, tenantId },
      orderBy: { dayNumber: 'asc' },
      select: { dayNumber: true, amountPaid: true, dueDate: true, status: true },
    });
    const now = new Date();
    const schedule = scheduleRows.map((r) => ({
      month: r.dayNumber,
      dueDate: r.dueDate.toISOString().split('T')[0],
      expectedAmount: new Decimal(r.amountPaid.toString()).toNumber(),
      status: (
        r.status === 'PAID' ? 'PAID'
        : r.dueDate < now ? 'OVERDUE'
        : 'UPCOMING'
      ) as 'PAID' | 'OVERDUE' | 'UPCOMING',
    }));

    return {
      id: loan.id,
      loanNumber: loan.loanNumber,
      status: loan.status,
      product: loan.loanProduct,
      principalAmount: new Decimal(loan.principalAmount.toString()).toNumber(),
      interestRate: new Decimal(loan.interestRate.toString()).toNumber(),
      processingFee: new Decimal(loan.processingFee.toString()).toNumber(),
      tenureMonths: loan.tenureMonths,
      monthlyInstalment: new Decimal(loan.monthlyInstalment.toString()).toNumber(),
      outstandingBalance: outstanding.toNumber(),
      accruedInterest: accruedInterest.toNumber(),
      totalAmountDue,
      totalRepaid: new Decimal(loan.totalRepaid.toString()).toNumber(),
      disbursedAt: loan.disbursedAt,
      dueDate: loan.dueDate,
      appliedAt: loan.appliedAt,
      guarantors: loan.guarantors.map((g) => ({
        memberNumber: g.member.memberNumber,
        memberName: `${g.member.user.firstName} ${g.member.user.lastName}`,
        guaranteedAmount: new Decimal(g.guaranteedAmount.toString()).toNumber(),
        status: g.status,
      })),
      recentTransactions: recentTransactions.map((t) => ({
        ...t,
        amount: new Decimal(t.amount.toString()).toNumber(),
        balanceBefore: new Decimal(t.balanceBefore.toString()).toNumber(),
        balanceAfter: new Decimal(t.balanceAfter.toString()).toNumber(),
      })),
      repaymentSchedule: schedule,
    };
  }

  // ─── MPESA DEPOSIT STATUS ─────────────────────────────────────

  /**
   * Check the status of an M-Pesa STK Push transaction.
   * Verifies the transaction belongs to the calling member's FOSA account.
   */
  async getDepositStatus(
    userId: string,
    checkoutRequestId: string,
    tenantId: string,
  ): Promise<{ status: 'PENDING' | 'SUCCESS' | 'FAILED'; amount?: string; completedAt?: Date | null }> {
    const member = await this.resolveMember(userId, tenantId);

    const fosaAccount = await this.prisma.account.findFirst({
      where: { memberId: member.id, tenantId, accountType: 'FOSA', isActive: true },
      select: { id: true },
    });

    const mpesaTx = await this.prisma.mpesaTransaction.findFirst({
      where: { checkoutRequestId, tenantId },
      select: {
        status: true,
        amount: true,
        updatedAt: true,
        transactionId: true,
      },
    });

    if (!mpesaTx) {
      throw new NotFoundException('M-Pesa transaction not found');
    }

    // Verify ownership: if a linked transaction exists, it must belong to this member's FOSA
    if (mpesaTx.transactionId && fosaAccount) {
      const linkedTx = await this.prisma.transaction.findUnique({
        where: { id: mpesaTx.transactionId },
        select: { accountId: true },
      });
      if (linkedTx && linkedTx.accountId !== fosaAccount.id) {
        throw new NotFoundException('M-Pesa transaction not found');
      }
    }

    const statusMap: Record<string, 'PENDING' | 'SUCCESS' | 'FAILED'> = {
      PENDING: 'PENDING',
      COMPLETED: 'SUCCESS',
      FAILED: 'FAILED',
      REVERSED: 'FAILED',
      RECON_PENDING: 'PENDING',
    };

    const mappedStatus = statusMap[mpesaTx.status] ?? 'PENDING';

    return {
      status: mappedStatus,
      amount: mpesaTx.amount ? new Decimal(mpesaTx.amount.toString()).toString() : undefined,
      completedAt: mappedStatus === 'SUCCESS' ? mpesaTx.updatedAt : null,
    };
  }

  // ─── INTERNAL TRANSFER (FOSA ↔ BOSA) ──────────────────────────

  /**
   * Transfer funds between the member's own FOSA and BOSA accounts.
   * Resolves account IDs from the account types in the DTO, then delegates
   * to AccountsService.transfer() → LedgerService.postInternalTransfer().
   */
  async internalTransfer(
    userId: string,
    tenantId: string,
    dto: InternalTransferDto,
    ipAddress?: string,
  ) {
    const member = await this.resolveMember(userId, tenantId);

    // Find the member's active FOSA and BOSA accounts
    const accounts = await this.prisma.account.findMany({
      where: {
        tenantId,
        memberId: member.id,
        accountType: { in: [AccountType.FOSA, AccountType.BOSA] },
        isActive: true,
      },
      select: { id: true, accountType: true, accountNumber: true },
    });

    const sourceAccount = accounts.find((a) => a.accountType === dto.fromAccountType);
    const destAccount = accounts.find((a) => a.accountType === dto.toAccountType);

    if (!sourceAccount) {
      throw new NotFoundException(
        `No active ${dto.fromAccountType} account found for this member`,
      );
    }
    if (!destAccount) {
      throw new NotFoundException(
        `No active ${dto.toAccountType} account found for this member`,
      );
    }

    // Delegate to AccountsService.transfer() which uses LedgerService.postInternalTransfer()
    const result = await this.accountsService.transfer(
      sourceAccount.id,
      {
        destinationAccountId: destAccount.id,
        amount: dto.amount,
        idempotencyKey: dto.idempotencyKey,
        description: dto.narration ?? `Internal transfer ${dto.fromAccountType} → ${dto.toAccountType}`,
      },
      tenantId,
      userId,
      ipAddress,
    );

    return {
      message: `Successfully transferred KES ${dto.amount} from ${sourceAccount.accountNumber} to ${destAccount.accountNumber}`,
      fromAccount: sourceAccount.accountNumber,
      toAccount: destAccount.accountNumber,
      amount: dto.amount,
      newSourceBalance: result.newSourceBalance,
      newDestinationBalance: result.newDestinationBalance,
    };
  }

  // ─── HELPERS ─────────────────────────────────────────────────

  private async resolveMember(userId: string, tenantId: string) {
    const member = await this.prisma.member.findFirst({
      where: { userId, tenantId, isActive: true },
      select: {
        id: true,
        memberNumber: true,
        user: { select: { firstName: true, lastName: true, email: true } },
      },
    });
    if (!member) throw new NotFoundException('Member profile not found for this user');
    return member;
  }
}


