import { Body, Controller, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiSecurity, ApiTags, ApiHeader } from '@nestjs/swagger';
import { Tenant, UserRole } from '@prisma/client';
import { CurrentTenant } from '../common/decorators/current-tenant.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import type { AuthenticatedUser } from '../modules/auth/strategies/jwt.strategy';
import { LoanApplicationService } from './loan-application.service';
import { ApplyForLoanDto, ApproveLoanDto, CreateLoanApplicationDto, RejectLoanDto } from './dto/loan-application.dto';

@ApiTags('Phase 2 Loan Applications')
@ApiBearerAuth()
@ApiSecurity('X-Tenant-ID')
@ApiHeader({ name: 'X-Tenant-ID', description: 'Tenant identifier for multi-tenancy', required: true })
@Controller('loan/applications')
export class LoanApplicationController {
  constructor(private readonly loanApplications: LoanApplicationService) {}

  @Post()
  @Roles(UserRole.MEMBER, UserRole.LOAN_OFFICER, UserRole.MANAGER, UserRole.TENANT_ADMIN)
  create(
    @CurrentTenant() tenant: Tenant,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateLoanApplicationDto,
  ) {
    return this.loanApplications.createLoanApplication(tenant.id, user.id, dto);
  }

  @Post('submit')
  @Roles(UserRole.MEMBER, UserRole.LOAN_OFFICER, UserRole.MANAGER, UserRole.TENANT_ADMIN)
  applyForLoan(
    @CurrentTenant() tenant: Tenant,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ApplyForLoanDto,
  ) {
    return this.loanApplications.applyForLoan(tenant.id, user.id, dto.loanId);
  }

  @Patch(':id/approve')
  @Roles(UserRole.MANAGER, UserRole.TENANT_ADMIN)
  approveLoan(
    @CurrentTenant() tenant: Tenant,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() _dto: ApproveLoanDto,
  ) {
    return this.loanApplications.approveLoan(tenant.id, user.id, id);
  }

  @Patch(':id/reject')
  @Roles(UserRole.MANAGER, UserRole.TENANT_ADMIN)
  rejectLoan(
    @CurrentTenant() tenant: Tenant,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RejectLoanDto,
  ) {
    return this.loanApplications.rejectLoan(tenant.id, user.id, id, dto.rejectionReason);
  }
}
