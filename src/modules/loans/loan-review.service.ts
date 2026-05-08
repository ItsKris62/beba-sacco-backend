import { BadRequestException, ConflictException, Injectable, Logger } from '@nestjs/common';
import { LoansService } from './loans.service';
import { IdempotencyService } from '../../common/services/idempotency.service';
import { ReviewLoanAction, ReviewLoanDto } from './dto/review-loan.dto';

@Injectable()
export class LoanReviewService {
  private readonly logger = new Logger(LoanReviewService.name);

  constructor(
    private readonly loans: LoansService,
    private readonly idempotency: IdempotencyService,
  ) {}

  async process(
    loanId: string,
    dto: ReviewLoanDto,
    tenantId: string,
    actorId: string,
    ipAddress?: string,
    idempotencyHeader?: string,
  ) {
    if (dto.action === ReviewLoanAction.DISBURSE && !idempotencyHeader?.trim()) {
      throw new BadRequestException('Idempotency-Key header is required for disbursement');
    }

    const idemKey = idempotencyHeader?.trim()
      ? `loan:review:${loanId}:${dto.action}:${idempotencyHeader.trim()}`
      : undefined;

    if (idemKey) {
      const check = await this.idempotency.checkAndReserve(idemKey, tenantId, 24 * 60 * 60);
      if (check.status === 'COMPLETED') return check.result;
      if (check.status === 'PROCESSING') {
        throw new ConflictException('Loan review request is already processing');
      }
    }

    try {
      const result = await this.execute(loanId, dto, tenantId, actorId, ipAddress);
      if (idemKey) {
        await this.idempotency.complete(idemKey, tenantId, result, 24 * 60 * 60);
      }
      return result;
    } catch (error) {
      if (idemKey && (error instanceof BadRequestException || error instanceof ConflictException)) {
        await this.idempotency.release(idemKey, tenantId);
      }
      this.logger.warn(`Loan review failed loan=${loanId} action=${dto.action}: ${(error as Error).message}`);
      throw error;
    }
  }

  private async execute(
    loanId: string,
    dto: ReviewLoanDto,
    tenantId: string,
    actorId: string,
    ipAddress?: string,
  ) {
    switch (dto.action) {
      case ReviewLoanAction.APPROVE:
        return this.loans.approve(loanId, tenantId, actorId, dto.comment, ipAddress);
      case ReviewLoanAction.DECLINE:
        return this.loans.reject(loanId, { reason: dto.reason ?? '' }, tenantId, actorId, ipAddress);
      case ReviewLoanAction.DISBURSE:
        return this.loans.disburse(loanId, tenantId, actorId, ipAddress);
      default:
        throw new BadRequestException('Unsupported loan review action');
    }
  }
}
