import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiResponse, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { IsNumber, IsOptional, IsString, IsUUID, Matches, Min } from 'class-validator';
import { UserRole } from '@prisma/client';
import { GuarantorLookupService } from './guarantor-lookup.service';
import { PrismaService } from '../prisma/prisma.service';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentTenant } from '../common/decorators/current-tenant.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../modules/auth/strategies/jwt.strategy';
import type { Tenant } from '@prisma/client';

class GuarantorLookupDto {
  @IsString()
  @Matches(/^[0-9]{7,8}$/)
  idNumber!: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  requiredAmount?: number;

  @IsOptional()
  @IsUUID('4')
  loanProductId?: string;
}

@ApiTags('Member Portal — Guarantors')
@ApiBearerAuth()
@ApiSecurity('X-Tenant-ID')
@ApiHeader({ name: 'X-Tenant-ID', required: true })
@Roles(UserRole.MEMBER, UserRole.LOAN_OFFICER)
@Controller('members/guarantors')
export class GuarantorLookupController {
  constructor(
    private readonly lookupService: GuarantorLookupService,
    private readonly prisma: PrismaService,
  ) {}

  @Post('lookup')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Lookup an eligible guarantor by National ID only',
    description:
      'When loanProductId is supplied, the balance check uses the product requiredAccountType. ' +
      'Products without a requiredAccountType fall back to FOSA because guarantor holds are placed on FOSA by default.',
  })
  @ApiResponse({ status: 200, description: 'Masked guarantor eligibility result' })
  async lookup(
    @Body() dto: GuarantorLookupDto,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentTenant() tenant: Tenant,
  ) {
    const member = await this.prisma.member.findFirst({
      where: { tenantId: tenant.id, userId: user.id, isActive: true },
      select: { id: true },
    });
    if (!member) throw new Error('Member profile not found');
    return this.lookupService.lookupByNationalId(dto.idNumber, tenant.id, member.id, dto.requiredAmount ?? 0, dto.loanProductId);
  }
}
