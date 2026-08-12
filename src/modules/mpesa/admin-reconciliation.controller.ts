import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiHeader,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiSecurity,
  ApiTags,
} from '@nestjs/swagger';
import { Tenant, UserRole } from '@prisma/client';
import { Request } from 'express';
import { CurrentTenant } from '../../common/decorators/current-tenant.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import type { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import { AdminReconciliationService } from './admin-reconciliation.service';
import {
  ControlledResendDto,
  ManualCompletionDto,
  ManualReversalDto,
  ManualStatusRefreshDto,
} from './dto/reconciliation-recover.dto';

@ApiTags('Admin - M-Pesa Reconciliation')
@ApiBearerAuth()
@ApiSecurity('X-Tenant-ID')
@ApiHeader({ name: 'X-Tenant-ID', required: true, description: 'Tenant UUID' })
@Controller('admin')
export class AdminReconciliationController {
  constructor(private readonly reconciliation: AdminReconciliationService) {}

  @Get('reconciliations/pending')
  @Roles(UserRole.AUDITOR, UserRole.ACCOUNTANT, UserRole.MANAGER, UserRole.TENANT_ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'List M-Pesa withdrawals requiring reconciliation or operational review',
    description:
      'Tenant-scoped read model for stale withdrawals, RECON_PENDING items, stale payout intents, ' +
      'dead letters, mismatches, and manual-review cases. Phone numbers are masked.',
  })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'offset', required: false, type: Number })
  @ApiQuery({ name: 'fromDate', required: false, type: String, description: 'ISO date' })
  @ApiQuery({ name: 'toDate', required: false, type: String, description: 'ISO date' })
  @ApiResponse({ status: 200, description: 'Pending reconciliation cases' })
  async pending(
    @CurrentTenant() tenant: Tenant,
    @Query('limit') limit?: number,
    @Query('offset') offset?: number,
    @Query('fromDate') fromDate?: string,
    @Query('toDate') toDate?: string,
  ) {
    return this.reconciliation.listPending(tenant.id, {
      limit,
      offset,
      fromDate: fromDate ? new Date(fromDate) : undefined,
      toDate: toDate ? new Date(toDate) : undefined,
    });
  }

  @Post('reconciliations/:transactionId/refresh-status')
  @Roles(UserRole.ACCOUNTANT, UserRole.MANAGER, UserRole.TENANT_ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Refresh Mwaloni provider status for one withdrawal',
    description:
      'Queries Mwaloni, applies the same safe automated transition rules, and audits the actor.',
  })
  @ApiParam({ name: 'transactionId', description: 'MpesaTransaction UUID' })
  async refreshStatus(
    @Param('transactionId') transactionId: string,
    @Body() dto: ManualStatusRefreshDto,
    @CurrentTenant() tenant: Tenant,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.reconciliation.refreshStatus(transactionId, dto, tenant.id, actor.id, req.ip);
  }

  @Post('reconciliations/:transactionId/mark-completed')
  @Roles(UserRole.ACCOUNTANT, UserRole.MANAGER)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Mark a non-terminal withdrawal completed with provider evidence',
    description:
      'Privileged manual completion. Requires reason/evidence, does not create a ledger debit, and is audited.',
  })
  @ApiParam({ name: 'transactionId', description: 'MpesaTransaction UUID' })
  async markCompleted(
    @Param('transactionId') transactionId: string,
    @Body() dto: ManualCompletionDto,
    @CurrentTenant() tenant: Tenant,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.reconciliation.markCompleted(transactionId, dto, tenant.id, actor.id, req.ip);
  }

  @Post('reconciliations/:transactionId/reverse')
  @Roles(UserRole.ACCOUNTANT, UserRole.MANAGER)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Reverse a confirmed failed withdrawal',
    description:
      'Privileged manual reversal. Requires provider/operational evidence and uses LedgerService.reverseTransaction.',
  })
  @ApiParam({ name: 'transactionId', description: 'MpesaTransaction UUID' })
  async reverse(
    @Param('transactionId') transactionId: string,
    @Body() dto: ManualReversalDto,
    @CurrentTenant() tenant: Tenant,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.reconciliation.reverseConfirmedFailure(
      transactionId,
      dto,
      tenant.id,
      actor.id,
      req.ip,
    );
  }

  @Post('reconciliations/:transactionId/resend')
  @Roles(UserRole.ACCOUNTANT, UserRole.MANAGER)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Controlled resend request',
    description:
      'Currently blocked by policy unless a formal provider non-submission workflow is added. The request is audited.',
  })
  @ApiParam({ name: 'transactionId', description: 'MpesaTransaction UUID' })
  async resend(
    @Param('transactionId') transactionId: string,
    @Body() dto: ControlledResendDto,
    @CurrentTenant() tenant: Tenant,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.reconciliation.controlledResend(transactionId, dto, tenant.id, actor.id, req.ip);
  }
}
