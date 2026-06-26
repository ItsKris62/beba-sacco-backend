import { Body, Controller, Param, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiSecurity, ApiTags, ApiHeader } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { Roles } from '../../common/decorators/roles.decorator';
import { PrismaService } from '../../prisma/prisma.service';
import type { AuthenticatedUser } from '../../modules/auth/strategies/jwt.strategy';
import { RepaymentService } from './repayment.service';
import { RepayLoanDto } from './dto/repay-loan.dto';

interface AuthenticatedRequest {
  user: AuthenticatedUser;
}

@ApiTags('Loan Repayments')
@ApiBearerAuth()
@ApiSecurity('X-Tenant-ID')
@ApiHeader({ name: 'X-Tenant-ID', description: 'Tenant identifier for multi-tenancy', required: true })
@Controller()
export class RepaymentController {
  constructor(
    private readonly repayments: RepaymentService,
    private readonly prisma: PrismaService,
  ) {}

  @Post('loans/:loanId/repay')
  @Roles(UserRole.MEMBER)
  async repayFromFosa(
    @Param('loanId') loanId: string,
    @Req() req: AuthenticatedRequest,
    @Body() dto: RepayLoanDto,
  ) {
    const member = await this.prisma.member.findFirst({
      where: { userId: req.user.id, tenantId: req.user.tenantId, isActive: true },
      select: { id: true },
    });
    if (!member) throw new Error('Member profile not found');
    return this.repayments.repayFromFosa(member.id, loanId, dto.amount);
  }
}
