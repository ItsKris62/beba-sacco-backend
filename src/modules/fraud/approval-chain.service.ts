import {
  Injectable, Logger, NotFoundException,
  BadRequestException, ForbiddenException,
} from '@nestjs/common';
import { Decimal } from 'decimal.js';
import { ApprovalStatus, LoanStatus, UserRole } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';

/** KES threshold above which a 4-eyes (dual) approval is required */
const DUAL_APPROVAL_THRESHOLD = 500_000;

/**
 * ApprovalChainService – Phase 4 (4-Eyes Principle)
 *
 * For loan disbursements ≥ KES 500,000:
 *   1. On disbursement request: create two approval slots
 *      (MANAGER + LOAN_OFFICER).
 *   2. Both approvers must independently call `signOff()`.
 *   3. Only after both slots are APPROVED does disbursement proceed.
 *
 * Prevents a single actor from approving high-value disbursements.
 */
@Injectable()
export class ApprovalChainService {
  private readonly logger = new Logger(ApprovalChainService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Returns true if the loan amount requires dual approval */
  requiresDualApproval(principalAmount: Decimal | string | number): boolean {
    return new Decimal(principalAmount.toString()).gte(DUAL_APPROVAL_THRESHOLD);
  }

  /**
   * Initialise an approval chain for a loan (call on APPROVED → DISBURSED transition).
   * Creates two pending approval slots: one for MANAGER, one for LOAN_OFFICER.
   */
  async initApprovalChain(
    loanId: string,
    tenantId: string,
  ): Promise<void> {
    // Idempotency: skip if chain already exists
    const existing = await this.prisma.loanApprovalChain.count({ where: { loanId, tenantId } });
    if (existing > 0) return;

    await this.prisma.loanApprovalChain.createMany({
      data: [
        { loanId, tenantId, approverId: '', role: UserRole.MANAGER,      status: ApprovalStatus.PENDING },
        { loanId, tenantId, approverId: '', role: UserRole.TELLER,       status: ApprovalStatus.PENDING },
      ],
    });

    this.logger.log(`Approval chain initialised for loan=${loanId}`);
  }

  /**
   * An approver signs off on a loan disbursement.
   * @param loanId   Loan being signed off
   * @param approverId  userId of the approver
   * @param role     Role of the approver (must be MANAGER or TELLER/LOAN_OFFICER)
   * @param approve  true = approve, false = reject
   * @param notes    Optional notes
   */
  async signOff(
    loanId: string,
    tenantId: string,
    approverId: string,
    role: UserRole,
    approve: boolean,
    notes?: string,
    ipAddress?: string,
  ): Promise<{ chainComplete: boolean; allApproved: boolean }> {
    const chain = await this.prisma.loanApprovalChain.findMany({
      where: { loanId, tenantId },
    });
    if (chain.length === 0) throw new NotFoundException('Approval chain not found for this loan');

    // Find the slot matching this approver's role
    const slot = chain.find((c) => c.role === role && c.status === ApprovalStatus.PENDING);
    if (!slot) throw new BadRequestException(`No pending approval slot for role ${role}`);

    // Guard against self-approval (same person approving twice)
    const alreadySigned = chain.find((c) => c.approverId === approverId && c.status !== ApprovalStatus.PENDING);
    if (alreadySigned) {
      throw new ForbiddenException('An approver cannot sign off more than once on the same loan');
    }

    const newStatus = approve ? ApprovalStatus.APPROVED : ApprovalStatus.REJECTED;

    await this.prisma.loanApprovalChain.update({
      where: { id: slot.id },
      data: { approverId, status: newStatus, notes, decidedAt: new Date() },
    });

    await this.audit.create({
      tenantId,
      userId: approverId,
      action: approve ? 'LOAN.DUAL_APPROVAL_SIGNED' : 'LOAN.DUAL_APPROVAL_REJECTED',
      resource: 'Loan',
      resourceId: loanId,
      metadata: { role, approve, notes },
      ipAddress,
    }).catch((e: unknown) => this.logger.error('Audit write failed', e));

    // Re-fetch after update
    const updated = await this.prisma.loanApprovalChain.findMany({ where: { loanId, tenantId } });
    const allApproved = updated.every((c) => c.status === ApprovalStatus.APPROVED);
    const anyRejected = updated.some((c) => c.status === ApprovalStatus.REJECTED);
    const chainComplete = allApproved || anyRejected;

    if (anyRejected) {
      // If any slot is rejected, push the loan back to APPROVED (block disburse)
      await this.prisma.loan.update({
        where: { id: loanId },
        data: { status: LoanStatus.APPROVED },
      });
    }

    return { chainComplete, allApproved };
  }

  /**
   * Checks whether all approval chain slots for a loan are APPROVED.
   * Called by the disburse path to gate disbursement.
   */
  async isChainApproved(loanId: string, tenantId: string): Promise<boolean> {
    const chain = await this.prisma.loanApprovalChain.findMany({ where: { loanId, tenantId } });
    if (chain.length === 0) return true; // No chain required (below threshold)
    return chain.every((c) => c.status === ApprovalStatus.APPROVED);
  }
}
