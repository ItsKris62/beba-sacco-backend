import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, Req } from '@nestjs/common';
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
import { UserRole } from '@prisma/client';
import { Request } from 'express';
import { AdminReconciliationService } from './admin-reconciliation.service';
import { ReconciliationRecoverDto } from './dto/reconciliation-recover.dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentTenant } from '../../common/decorators/current-tenant.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import type { Tenant } from '@prisma/client';

/**
 * Admin recovery workflow for the two M-Pesa withdrawal edge cases that cannot be
 * resolved automatically — see AdminReconciliationService for the full case taxonomy.
 * Restricted to MANAGER: this endpoint moves real money outside the normal member-
 * initiated flows, so it deliberately excludes LOAN_OFFICER/TENANT_ADMIN/TELLER.
 */
@ApiTags('Admin — M-Pesa Reconciliation')
@ApiBearerAuth()
@ApiSecurity('X-Tenant-ID')
@ApiHeader({ name: 'X-Tenant-ID', required: true, description: 'Tenant UUID' })
@Roles(UserRole.MANAGER)
@Controller('admin')
export class AdminReconciliationController {
  constructor(private readonly reconciliation: AdminReconciliationService) {}

  @Get('reconciliations/pending')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'List M-Pesa withdrawals requiring manual reconciliation',
    description:
      'Two case types: STUCK_RECON_PENDING (a withdrawal stuck past the auto-refund grace ' +
      'window — either a legacy row with no linked ledger transaction, or one whose auto-refund ' +
      'keeps failing) and LATE_SUCCESS_DOUBLE_CREDIT (a Safaricom success callback arrived after ' +
      'the system already auto-refunded the same withdrawal — potential double-credit, resolvable ' +
      'only by a human confirming with Safaricom).',
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

  @Post('reconciliations/:transactionId/recover')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Execute manual recovery for a stuck or double-credited M-Pesa withdrawal',
    description:
      'MANUAL_B2C_PAYOUT re-debits the FOSA account (only if it was previously auto-refunded) ' +
      'and sends the member their money via a fresh Daraja B2C call, protected by the same ' +
      '30-minute timeout + reconciliation sweep as any other B2C payout. REVERSE_AUTO_REFUND ' +
      'undoes an incorrect auto-refund by re-debiting the FOSA account. Both require investigation ' +
      'notes and are recorded as MPESA.WITHDRAWAL.MANUALLY_RECOVERED in the audit trail.',
  })
  @ApiParam({ name: 'transactionId', description: 'MpesaTransaction UUID' })
  @ApiResponse({ status: 200, description: 'Recovery executed' })
  @ApiResponse({ status: 400, description: 'Invalid action for this transaction’s current state' })
  @ApiResponse({ status: 404, description: 'Transaction not found' })
  @ApiResponse({ status: 409, description: 'Ledger state inconsistent — requires investigation' })
  async recover(
    @Param('transactionId') transactionId: string,
    @Body() dto: ReconciliationRecoverDto,
    @CurrentTenant() tenant: Tenant,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.reconciliation.recover(transactionId, dto, tenant.id, actor.id, req.ip);
  }
}
