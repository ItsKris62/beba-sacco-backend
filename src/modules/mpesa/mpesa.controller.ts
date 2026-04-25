import {
  Controller,
  Post,
  Body,
  Param,
  Headers,
  Req,
  HttpCode,
  HttpStatus,
  UseGuards,
  Logger,
} from '@nestjs/common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiSecurity,
  ApiOperation,
  ApiResponse,
  ApiHeader,
  ApiParam,
} from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { RawBodyRequest } from '@nestjs/common';
import { Request } from 'express';
import * as crypto from 'crypto';
import { ConfigService } from '@nestjs/config';
import { UserRole, MpesaTriggerSource } from '@prisma/client';
import { MpesaService } from './mpesa.service';
import { MemberDepositDto } from './dto/deposit-request.dto';
import { MpesaIpGuard } from './guards/mpesa-ip.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { CurrentTenant } from '../../common/decorators/current-tenant.decorator';
import type { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import type { Tenant } from '@prisma/client';
import {
  isStkCallback,
  isC2bCallback,
  isB2cCallback,
} from './dto/mpesa-callback.dto';

// ─── Response shapes ──────────────────────────────────────────────────────────

class DepositInitiatedResponse {
  checkoutRequestId!: string;
  customerMessage!: string;
  mpesaTxId!: string;
}

class DisbursementQueuedResponse {
  jobId!: string;
}

class DlqRequeueResponse {
  requeued!: boolean;
  jobId!: string;
}

const DARAJA_ACK = { ResultCode: 0, ResultDesc: 'Accepted' };

// ─────────────────────────────────────────────────────────────────────────────

@ApiTags('M-Pesa')
@ApiBearerAuth()
@ApiSecurity('X-Tenant-ID')
@ApiHeader({ name: 'X-Tenant-ID', required: true, description: 'Tenant UUID' })
@Controller('mpesa')
export class MpesaController {
  private readonly logger = new Logger(MpesaController.name);
  private readonly webhookSecret: string | undefined;

  constructor(
    private readonly mpesaService: MpesaService,
    private readonly config: ConfigService,
  ) {
    this.webhookSecret = this.config.get<string>('app.mpesa.webhookSecret');
  }

  // ─── Member deposit / repayment ──────────────────────────────────────────

  /**
   * POST /api/mpesa/members/deposit
   *
   * Triggers an STK Push to the member's phone.
   * Rate-limited to MPESA_STK_RATE_LIMIT_PER_DAY (default 3) per member per
   * calendar day (EAT midnight reset) per SASRA requirements.
   */
  @Post('members/deposit')
  @Roles(UserRole.MEMBER, UserRole.TELLER, UserRole.MANAGER, UserRole.TENANT_ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Member deposit or loan repayment via M-Pesa (STK Push)',
    description:
      'Sends an STK Push prompt to the member\'s phone. ' +
      'Set purpose=SAVINGS and accountRef to the account number for a deposit. ' +
      'Set purpose=LOAN_REPAYMENT and accountRef to the loan number for a repayment. ' +
      'Result delivered asynchronously.',
  })
  @ApiResponse({ status: 200, description: 'STK Push initiated', type: DepositInitiatedResponse })
  @ApiResponse({ status: 400, description: 'Rate limit exceeded, invalid phone, or account not found' })
  @ApiResponse({ status: 401, description: 'Unauthenticated' })
  @ApiResponse({ status: 403, description: 'Insufficient role' })
  async memberDeposit(
    @Body() dto: MemberDepositDto,
    @CurrentTenant() tenant: Tenant,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<DepositInitiatedResponse> {
    const triggerSource =
      actor.role === UserRole.MEMBER ? MpesaTriggerSource.MEMBER : MpesaTriggerSource.OFFICER;
    return this.mpesaService.initiateDeposit(dto, tenant.id, actor.id, actor.id, triggerSource);
  }

  // ─── Admin: queue B2C disbursement ──────────────────────────────────────

  /**
   * POST /api/mpesa/loans/:loanId/disburse
   *
   * Queues a B2C loan disbursement. Normally triggered by the loan-approval
   * workflow; this endpoint lets officers manually trigger after a failure.
   * The job is idempotent (same loanId → same BullMQ jobId).
   */
  @Post('loans/:loanId/disburse')
  @Roles(UserRole.TENANT_ADMIN, UserRole.MANAGER)
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Queue B2C loan disbursement (admin/officer)',
    description:
      'Enqueues a B2C payment job for the specified loan. ' +
      'The loan must be in APPROVED status. ' +
      'Disbursement is processed asynchronously; the loan transitions to DISBURSED ' +
      'after Safaricom confirms the B2C payment.',
  })
  @ApiParam({ name: 'loanId', description: 'Loan UUID' })
  @ApiResponse({ status: 202, description: 'Disbursement job queued', type: DisbursementQueuedResponse })
  @ApiResponse({ status: 404, description: 'Loan not found' })
  @ApiResponse({ status: 403, description: 'Insufficient role' })
  async queueDisbursement(
    @Param('loanId') loanId: string,
    @CurrentTenant() tenant: Tenant,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<DisbursementQueuedResponse> {
    return this.mpesaService.queueLoanDisbursement(loanId, tenant.id, actor.id);
  }

  // ─── Admin: replay a DLQ job ─────────────────────────────────────────────

  /**
   * POST /api/mpesa/admin/dlq/:jobId/requeue
   *
   * Moves a failed callback job from MPESA_CALLBACK_DLQ back into the live
   * mpesa.callback queue for replay. Use only after manual investigation —
   * DLQ jobs failed for a reason and blind replays can cause double-posting.
   *
   * Access: TENANT_ADMIN, MANAGER only.
   */
  @Post('admin/dlq/:jobId/requeue')
  @Roles(UserRole.TENANT_ADMIN, UserRole.MANAGER)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Replay a failed M-Pesa callback from the dead-letter queue',
    description:
      'Moves the specified DLQ job back to the live mpesa.callback queue. ' +
      'Only use after manual investigation of why the job failed. ' +
      'Idempotency: replayed jobs get a new jobId (dlq-replay-{original}-{ts}) ' +
      'to avoid BullMQ dedup suppression.',
  })
  @ApiParam({ name: 'jobId', description: 'DLQ job ID to replay' })
  @ApiResponse({ status: 200, description: 'Job re-enqueued', type: DlqRequeueResponse })
  @ApiResponse({ status: 404, description: 'Job not found in DLQ' })
  @ApiResponse({ status: 403, description: 'Insufficient role' })
  async requeueDlqJob(
    @Param('jobId') jobId: string,
  ): Promise<DlqRequeueResponse> {
    return this.mpesaService.requeueFromDlq(jobId);
  }

  // ─── Unified Daraja callback ──────────────────────────────────────────────

  /**
   * POST /api/mpesa/callback
   *
   * Receives STK Push results, C2B payments, and B2C results from Safaricom.
   * Always ACKs immediately (ResultCode 0) so Daraja stops retrying.
   * Real processing happens in MpesaCallbackProcessor via BullMQ.
   */
  @Public()
  @SkipThrottle()
  @Post('callback')
  @UseGuards(MpesaIpGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Unified Safaricom Daraja callback (STK / C2B / B2C)' })
  @ApiResponse({ status: 200, description: 'Callback acknowledged' })
  async unifiedCallback(
    @Req() req: RawBodyRequest<Request>,
    @Body() body: Record<string, unknown>,
    @Headers('x-mpesa-signature') signature?: string,
  ) {
    if (!this.isSignatureValid(req.rawBody, signature)) {
      this.logger.warn('Unified callback: invalid HMAC signature – discarding');
      return DARAJA_ACK;
    }

    if (isStkCallback(body)) {
      const checkoutId = body.Body.stkCallback.CheckoutRequestID;
      await this.mpesaService.enqueueCallback(body as Record<string, unknown>, 'STK_PUSH', checkoutId);
    } else if (isC2bCallback(body)) {
      await this.mpesaService.enqueueCallback(body as Record<string, unknown>, 'C2B', body.TransID);
    } else if (isB2cCallback(body)) {
      const convId = body.Result.ConversationID;
      const isTimeout =
        body.Result.ResultCode === 17 || body.Result.ResultDesc?.includes('timeout');
      await this.mpesaService.enqueueCallback(
        body as Record<string, unknown>,
        isTimeout ? 'B2C_TIMEOUT' : 'B2C_RESULT',
        convId,
      );
    }
    return DARAJA_ACK;
  }

  /**
   * Validates HMAC-SHA256 signature using the raw request bytes.
   * Permissive when MPESA_WEBHOOK_SECRET is not configured (dev/sandbox).
   * Uses constant-time comparison to prevent timing-oracle attacks.
   */
  private isSignatureValid(rawBody: Buffer | undefined, signature: string | undefined): boolean {
    if (!this.webhookSecret) return true;
    if (!signature || !rawBody) return false;

    const expected = crypto
      .createHmac('sha256', this.webhookSecret)
      .update(rawBody)
      .digest('hex');

    const expectedBuf = Buffer.from(expected, 'hex');
    let sigBuf: Buffer;
    try {
      sigBuf = Buffer.from(signature, 'hex');
    } catch {
      return false;
    }
    if (expectedBuf.length !== sigBuf.length) return false;
    return crypto.timingSafeEqual(expectedBuf, sigBuf);
  }
}
