import { Body, Controller, Param, Patch, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiSecurity, ApiTags, ApiHeader } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { Roles } from '../../common/decorators/roles.decorator';
import type { AuthenticatedUser } from '../../modules/auth/strategies/jwt.strategy';
import { GuarantorService } from './guarantor.service';
import { RequestGuarantorDto } from './dto/request-guarantor.dto';
import { RespondGuarantorDto } from './dto/respond-guarantor.dto';

interface AuthenticatedRequest {
  user: AuthenticatedUser;
}

@ApiTags('Guarantors')
@ApiBearerAuth()
@ApiSecurity('X-Tenant-ID')
@ApiHeader({ name: 'X-Tenant-ID', description: 'Tenant identifier for multi-tenancy', required: true })
@Controller()
export class GuarantorController {
  constructor(private readonly guarantors: GuarantorService) {}

  @Post('loans/:loanId/guarantors/request')
  @Roles(UserRole.MEMBER, UserRole.LOAN_OFFICER, UserRole.MANAGER, UserRole.TENANT_ADMIN)
  requestGuarantor(
    @Param('loanId') loanId: string,
    @Req() req: AuthenticatedRequest,
    @Body() dto: RequestGuarantorDto,
  ) {
    return this.guarantors.requestGuarantor(loanId, req.user.id, dto.targetMemberId);
  }

  @Patch('guarantors/:guarantorId/respond')
  @Roles(UserRole.MEMBER)
  respondToRequest(
    @Param('guarantorId') guarantorId: string,
    @Req() req: AuthenticatedRequest,
    @Body() dto: RespondGuarantorDto,
  ) {
    return this.guarantors.respondToRequest(guarantorId, dto.response, req.user.id);
  }
}
