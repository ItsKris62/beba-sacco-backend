import {
  Controller, Get, Patch, Post, Body, Param, Req,
  HttpCode, HttpStatus, ParseUUIDPipe, UseGuards,
} from '@nestjs/common';
import {
  ApiTags, ApiBearerAuth, ApiSecurity, ApiOperation,
  ApiResponse, ApiHeader, ApiParam,
} from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { Request } from 'express';
import { LoanApplicationService } from './loan-application.service';
import { UpdateLoanStatusDto } from './dto/update-loan-status.dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { CurrentTenant } from '../../common/decorators/current-tenant.decorator';
import type { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import type { Tenant } from '@prisma/client';

/**
 * Admin Loan Controller
 *
 * Restricted to MANAGER and TENANT_ADMIN roles.
 * Provides loan oversight, guarantor exposure checks, and status management.
 */
@ApiTags('Admin — Loans')
@ApiBearerAuth()
@ApiSecurity('X-Tenant-ID')
@ApiHeader({ name: 'X-Tenant-ID', required: true, description: 'Tenant UUID' })
@Roles(UserRole.MANAGER, UserRole.TENANT_ADMIN)
@Controller('admin')
export class LoanAdminController {
  constructor(private readonly loanApp: LoanApplicationService) {}

  @Get('members/:id/guarantor-exposure')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Get guarantor exposure for a member',
    description:
      'Returns total guarantee exposure, active guarantees, and remaining capacity. ' +
      'Used by loan officers to verify guarantor eligibility before invitation.',
  })
  @ApiParam({ name: 'id', description: 'Member UUID' })
  @ApiResponse({ status: 200, description: 'Guarantor exposure data' })
  @ApiResponse({ status: 404, description: 'Member not found' })
  async getGuarantorExposure(
    @Param('id', ParseUUIDPipe) memberId: string,
    @CurrentTenant() tenant: Tenant,
  ) {
    return this.loanApp.getGuarantorExposure(memberId, tenant.id);
  }

  @Patch('loans/:id/status')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Update loan application status',
    description:
      'Transition a loan through the approval workflow. ' +
      'Valid transitions: DRAFT → PENDING_GUARANTORS | REJECTED, ' +
      'PENDING_GUARANTORS → UNDER_REVIEW | REJECTED, ' +
      'UNDER_REVIEW → APPROVED | REJECTED. ' +
      'Reason is required for REJECTED.',
  })
  @ApiParam({ name: 'id', description: 'Loan UUID' })
  @ApiResponse({ status: 200, description: 'Status updated' })
  @ApiResponse({ status: 400, description: 'Invalid status transition or missing reason' })
  @ApiResponse({ status: 403, description: 'Insufficient privileges' })
  async updateStatus(
    @Param('id', ParseUUIDPipe) loanId: string,
    @Body() dto: UpdateLoanStatusDto,
    @CurrentTenant() tenant: Tenant,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.loanApp.updateStatus(loanId, dto, tenant.id, actor, req);
  }
}
