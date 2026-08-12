import { Injectable } from '@nestjs/common';
import {
  ControlledResendDto,
  ManualCompletionDto,
  ManualReversalDto,
  ManualStatusRefreshDto,
} from './dto/reconciliation-recover.dto';
import { WithdrawalReconciliationService } from './withdrawal-reconciliation.service';

@Injectable()
export class AdminReconciliationService {
  constructor(private readonly withdrawalRecon: WithdrawalReconciliationService) {}

  async listPending(
    tenantId: string,
    opts: { limit?: number; offset?: number; fromDate?: Date; toDate?: Date } = {},
  ) {
    return this.withdrawalRecon.listOperationalCases(tenantId, opts);
  }

  async refreshStatus(
    mpesaTransactionId: string,
    dto: ManualStatusRefreshDto,
    tenantId: string,
    actorId: string,
    ipAddress?: string,
  ) {
    return this.withdrawalRecon.refreshProviderStatus(
      mpesaTransactionId,
      tenantId,
      actorId,
      dto,
      ipAddress,
    );
  }

  async markCompleted(
    mpesaTransactionId: string,
    dto: ManualCompletionDto,
    tenantId: string,
    actorId: string,
    ipAddress?: string,
  ) {
    return this.withdrawalRecon.markCompletedWithEvidence(
      mpesaTransactionId,
      tenantId,
      actorId,
      dto,
      ipAddress,
    );
  }

  async reverseConfirmedFailure(
    mpesaTransactionId: string,
    dto: ManualReversalDto,
    tenantId: string,
    actorId: string,
    ipAddress?: string,
  ) {
    return this.withdrawalRecon.reverseConfirmedFailure(
      mpesaTransactionId,
      tenantId,
      actorId,
      dto,
      ipAddress,
    );
  }

  async controlledResend(
    mpesaTransactionId: string,
    dto: ControlledResendDto,
    tenantId: string,
    actorId: string,
    ipAddress?: string,
  ) {
    return this.withdrawalRecon.controlledResend(
      mpesaTransactionId,
      tenantId,
      actorId,
      dto,
      ipAddress,
    );
  }
}
