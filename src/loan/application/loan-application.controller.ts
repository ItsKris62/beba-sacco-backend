import { Body, Controller, Param, Patch, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiSecurity, ApiTags, ApiHeader } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { Roles } from '../../common/decorators/roles.decorator';
import { PrismaService } from '../../prisma/prisma.service';
import type { AuthenticatedUser } from '../../modules/auth/strategies/jwt.strategy';
import { LoanApplicationService } from './loan-application.service';
import { ApplyLoanDto } from './dto/apply-loan.dto';
import { RejectLoanDto } from './dto/reject-loan.dto';

interface AuthenticatedRequest {
  user: AuthenticatedUser;
}

@ApiTags('Loan Applications')
@ApiBearerAuth()
@ApiSecurity('X-Tenant-ID')
@ApiHeader({ name: 'X-Tenant-ID', description: 'Tenant identifier for multi-tenancy', required: true })
@Controller()
export class LoanApplicationController {
  constructor(
    private readonly loanApplications: LoanApplicationService,
    private readonly prisma: PrismaService,
  ) {}

  @Post('loans/apply')
  @Roles(UserRole.MEMBER)
  async applyForLoan(@Req() req: AuthenticatedRequest, @Body() dto: ApplyLoanDto) {
    const member = await this.prisma.member.findFirst({
      where: { userId: req.user.id, tenantId: req.user.tenantId, isActive: true },
      select: { id: true },
    });
    if (!member) throw new Error('Member profile not found');
    return this.loanApplications.applyForLoan(member.id, dto.loanProductId, dto.amount, dto.purpose);
  }

  @Post('loans/:id/submit')
  @Roles(UserRole.MEMBER)
  async submitForApproval(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    const member = await this.prisma.member.findFirst({
      where: { userId: req.user.id, tenantId: req.user.tenantId, isActive: true },
      select: { id: true },
    });
    if (!member) throw new Error('Member profile not found');
    return this.loanApplications.submitForApproval(id, member.id);
  }

  @Patch('admin/loans/:id/approve')
  @Roles(UserRole.LOAN_OFFICER, UserRole.MANAGER)
  approveLoan(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    return this.loanApplications.approveLoan(id, req.user.id);
  }

  @Patch('admin/loans/:id/reject')
  @Roles(UserRole.LOAN_OFFICER, UserRole.MANAGER)
  rejectLoan(
    @Param('id') id: string,
    @Req() req: AuthenticatedRequest,
    @Body() dto: RejectLoanDto,
  ) {
    return this.loanApplications.rejectLoan(id, req.user.id, dto.reason);
  }
}
