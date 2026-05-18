import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Headers,
  Req,
  HttpCode,
  HttpStatus,
  UseFilters,
  UseGuards,
  Logger,
  ServiceUnavailableException,
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
import { RawBodyRequest } from '@nestjs/common';
import { Request } from 'express';
import * as crypto from 'crypto';
import { ConfigService } from '@nestjs/config';
import { v4 as uuidv4 } from 'uuid';
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
import { MpesaExceptionFilter } from './filters/mpesa-exception.filter';
import { MpesaTransactionStatusDto } from './dto/mpesa-transaction-status.dto';
import { MpesaTenantResolverService } from './mpesa-tenant-resolver.service';

// â”€â”€â”€ Response shapes â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

@ApiTags('M-Pesa')
@ApiBearerAuth()
@ApiSecurity('X-Tenant-ID')
@ApiHeader({ name: 'X-Tenant-ID', required: true, description: 'Tenant UUID' })
@UseFilters(MpesaExceptionFilter)
@Controller('mpesa')
export class MpesaController {
  private readonly logger = new Logger(MpesaController.name);
  private readonly webhookSecret: string | undefined;
  private readonly isProduction: boolean;

  constructor(
    private readonly mpesaService: MpesaService,
    private readonly config: ConfigService,
    private readonly tenantResolver: MpesaTenantResolverService,
  ) {
    this.webhookSecret = this.config.get<string>('app.mpesa.webhookSecret');
    this.isProduction = this.config.get<string>('app.nodeEnv') === 'production';
  }

  onModuleInit(): void {
    if (!this.webhookSecret) {
      if (this.isProduction) {
        this.logger.warn(
          'âš ï¸  MPESA_WEBHOOK_SECRET is not set in production. ' +
            'All incoming Daraja callbacks will be rejected until this is configured.',
        );
      } else {
        this.logger.warn(
          'MPESA_WEBHOOK_SECRET not configured â€” HMAC signature validation is DISABLED. ' +
            'Safe for sandbox/staging only.',
        );
      }
    }
  }

  // â”€â”€â”€ Member deposit / repayment â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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
      "Sends an STK Push prompt to the member's phone. " +
      'Set purpose=SAVINGS and accountRef to the account number for a deposit. ' +
      'Set purpose=LOAN_REPAYMENT and accountRef to the loan number for a repayment. ' +
      'Result delivered asynchronously.',
  })
  @ApiResponse({ status: 200, description: 'STK Push initiated', type: DepositInitiatedResponse })
  @ApiResponse({
    status: 400,
    description: 'Rate limit exceeded, invalid phone, or account not found',
  })
  @ApiResponse({ status: 401, description: 'Unauthenticated' })
  @ApiResponse({ status: 403, description: 'Insufficient role' })
  @ApiResponse({
    status: 503,
    description: 'M-Pesa temporarily unavailable â€” retryable',
    schema: {
      properties: {
        statusCode: { type: 'number' },
        error: { type: 'string' },
        message: { type: 'string' },
        retryable: { type: 'boolean' },
      },
    },
  })
  @ApiHeader({
    name: 'X-Idempotency-Key',
    required: true,
    description: 'Required to prevent duplicate STK prompts on retry',
  })
  async memberDeposit(
    @Body() dto: MemberDepositDto,
    @CurrentTenant() tenant: Tenant,
    @CurrentUser() actor: AuthenticatedUser,
    @Headers('x-idempotency-key') idempotencyKey?: string,
  ): Promise<DepositInitiatedResponse> {
    const triggerSource =
      actor.role === UserRole.MEMBER ? MpesaTriggerSource.MEMBER : MpesaTriggerSource.OFFICER;
    return this.mpesaService.initiateDeposit(
      dto,
      tenant.id,
      actor.id,
      actor.id,
      triggerSource,
      idempotencyKey,
    );
  }

  // â”€â”€â”€ Admin: queue B2C disbursement â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  /**
   * POST /api/mpesa/loans/:loanId/disburse
   *
   * Queues a B2C loan disbursement. Normally triggered by the loan-approval
   * workflow; this endpoint lets officers manually trigger after a failure.
   * The job is idempotent (same loanId â†’ same BullMQ jobId).
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
  @ApiResponse({
    status: 202,
    description: 'Disbursement job queued',
    type: DisbursementQueuedResponse,
  })
  @ApiResponse({ status: 404, description: 'Loan not found' })
  @ApiResponse({ status: 403, description: 'Insufficient role' })
  async queueDisbursement(
    @Param('loanId') loanId: string,
    @CurrentTenant() tenant: Tenant,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<DisbursementQueuedResponse> {
    return this.mpesaService.queueLoanDisbursement(loanId, tenant.id, actor.id);
  }

  @Get('transactions/:checkoutRequestId/status')
  @Roles(
    UserRole.MEMBER,
    UserRole.TELLER,
    UserRole.MANAGER,
    UserRole.TENANT_ADMIN,
    UserRole.SUPER_ADMIN,
  )
  @ApiOperation({ summary: 'Get M-Pesa STK transaction status for polling' })
  @ApiParam({ name: 'checkoutRequestId', description: 'M-Pesa checkout request ID' })
  @ApiResponse({ status: 200, description: 'Transaction status', type: MpesaTransactionStatusDto })
  @ApiResponse({ status: 404, description: 'Transaction not found' })
  async getTransactionStatus(
    @Param('checkoutRequestId') checkoutRequestId: string,
    @CurrentTenant() tenant: Tenant,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<MpesaTransactionStatusDto> {
    return this.mpesaService.getTransactionStatus(checkoutRequestId, actor.id, tenant.id);
  }

  // â”€â”€â”€ Admin: replay a DLQ job â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  /**
   * POST /api/mpesa/admin/dlq/:jobId/requeue
   *
   * Moves a failed callback job from MPESA_CALLBACK_DLQ back into the live
   * mpesa.callback queue for replay. Use only after manual investigation â€”
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
  async requeueDlqJob(@Param('jobId') jobId: string): Promise<DlqRequeueResponse> {
    return this.mpesaService.requeueFromDlq(jobId);
  }

  // â”€â”€â”€ Unified Daraja callback â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  /**
   * POST /api/mpesa/callback
   *
   * Receives STK Push results, C2B payments, and B2C results from Safaricom.
   * Always ACKs immediately (ResultCode 0) so Daraja stops retrying.
   * Real processing happens in MpesaCallbackProcessor via BullMQ.
   */
  @Public()
  @Post('callback')
  @UseGuards(MpesaIpGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Unified Safaricom Daraja callback (STK / C2B / B2C)' })
  @ApiHeader({ name: 'X-Mpesa-Signature', required: false, description: 'HMAC-SHA256 over raw callback body' })
  @ApiHeader({ name: 'X-Mpesa-Timestamp', required: false, description: 'Callback timestamp used for replay protection' })
  @ApiResponse({ status: 200, description: 'Callback acknowledged' })
  async unifiedCallback(
    @Req() req: RawBodyRequest<Request>,
    @Body() body: Record<string, unknown>,
    @Headers('x-mpesa-signature') signature?: string,
    @Headers('x-mpesa-timestamp') mpesaTimestamp?: string,
    @Headers('x-daraja-timestamp') darajaTimestamp?: string,
  ) {
    const correlationId = uuidv4();
    void this.acceptCallbackAsync({
      rawBody: req.rawBody,
      body,
      signature,
      timestamp: mpesaTimestamp ?? darajaTimestamp,
      correlationId,
    });
    return DARAJA_ACK;
  }

  /**
   * Validates HMAC-SHA256 signature using the raw request bytes.
   * Uses constant-time comparison to prevent timing-oracle attacks.
   *
   * Behavior when MPESA_WEBHOOK_SECRET is absent:
   *  - Non-production: logs a warning and skips validation (sandbox safe).
   *  - Production: throws ServiceUnavailableException so Daraja retries and
   *    operators are alerted immediately â€” no unvalidated webhooks go through.
   */
  private async acceptCallbackAsync(params: {
    rawBody?: Buffer;
    body: Record<string, unknown>;
    signature?: string;
    timestamp?: string;
    correlationId: string;
  }): Promise<void> {
    try {
      const valid = await this.tenantResolver.validateCallback({
        rawBody: params.rawBody,
        payload: params.body,
        signature: params.signature,
        timestamp: params.timestamp,
      });

      if (!valid) {
        return;
      }

      const resolved = await this.tenantResolver.resolveTenant(params.body);
      if (!resolved) {
        this.logger.warn(`M-Pesa callback accepted but tenant unresolved correlation=${params.correlationId}`);
        return;
      }

      await this.mpesaService.enqueueCallback(
        {
          ...params.body,
          tenantId: resolved.tenantId,
          correlationId: params.correlationId,
        },
        resolved.callbackType,
        resolved.uniqueId,
        resolved.tenantId,
        params.correlationId,
      );
    } catch (error) {
      this.logger.error(
        `M-Pesa callback async accept failed correlation=${params.correlationId}`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  private isSignatureValid(rawBody: Buffer | undefined, signature: string | undefined): boolean {
    if (!this.webhookSecret) {
      if (this.isProduction) {
        throw new ServiceUnavailableException(
          'MPESA_WEBHOOK_SECRET is not configured. ' +
            'Set the environment variable and redeploy before processing live callbacks.',
        );
      }
      // Non-production: permissive â€” sandbox callbacks have no secret
      return true;
    }

    if (!signature || !rawBody) return false;

    const expected = crypto.createHmac('sha256', this.webhookSecret).update(rawBody).digest('hex');

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
