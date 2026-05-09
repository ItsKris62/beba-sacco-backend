import { BadRequestException, Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiParam, ApiResponse, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { Request } from 'express';
import { UserRole } from '@prisma/client';
import { GuarantorResponseService, GuarantorWorkflowAction } from './guarantor-response.service';
import { PrismaService } from '../prisma/prisma.service';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentTenant } from '../common/decorators/current-tenant.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../modules/auth/strategies/jwt.strategy';
import type { Tenant } from '@prisma/client';

enum GuarantorDecision { ACCEPT = 'ACCEPT', DECLINE = 'DECLINE' }

class GuarantorResponseDto {
  @IsEnum(GuarantorDecision)
  action!: GuarantorDecision;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;

  @IsOptional()
  @IsBoolean()
  digitalAcknowledgment?: boolean;
}

class AdminGuarantorOverrideDto extends GuarantorResponseDto {
  @IsString()
  @MaxLength(1000)
  reason!: string;
}

@ApiTags('Loan Guarantor Workflow')
@ApiBearerAuth()
@ApiSecurity('X-Tenant-ID')
@ApiHeader({ name: 'X-Tenant-ID', required: true })
@Controller()
export class GuarantorResponseController {
  constructor(
    private readonly service: GuarantorResponseService,
    private readonly prisma: PrismaService,
  ) {}

  @Get('members/guarantor/requests')
  @Roles(UserRole.MEMBER, UserRole.LOAN_OFFICER)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'List pending guarantor requests for the authenticated member' })
  @ApiResponse({ status: 200, description: 'Pending guarantor requests' })
  async pending(@CurrentUser() user: AuthenticatedUser, @CurrentTenant() tenant: Tenant) {
    const memberId = await this.resolveMemberId(user.id, tenant.id);
    return this.service.getPendingRequests(tenant.id, memberId);
  }

  @Post('members/loans/:id/guarantor-response')
  @Roles(UserRole.MEMBER, UserRole.LOAN_OFFICER)
  @HttpCode(HttpStatus.OK)
  @ApiHeader({ name: 'X-Idempotency-Key', required: true })
  @ApiParam({ name: 'id', description: 'Loan UUID' })
  async respond(
    @Param('id') loanId: string,
    @Body() dto: GuarantorResponseDto,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentTenant() tenant: Tenant,
    @Req() req: Request,
  ) {
    const idempotencyKey = this.requireIdempotencyKey(req);
    const memberId = await this.resolveMemberId(user.id, tenant.id);
    return this.service.respondAsMember(
      loanId,
      memberId,
      { action: dto.action as GuarantorWorkflowAction, notes: dto.notes },
      tenant.id,
      user.id,
      req,
      idempotencyKey,
    );
  }

  @Patch('admin/loans/:loanId/guarantors/:guarantorId/status')
  @Roles(UserRole.MANAGER)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Manager override for a pending guarantor decision' })
  async override(
    @Param('loanId') loanId: string,
    @Param('guarantorId') guarantorId: string,
    @Body() dto: AdminGuarantorOverrideDto,
    @CurrentUser() actor: AuthenticatedUser,
    @CurrentTenant() tenant: Tenant,
    @Req() req: Request,
  ) {
    if (!dto.reason?.trim()) throw new BadRequestException('ADMIN_OVERRIDE_REASON_REQUIRED');
    return this.service.adminOverride(
      loanId,
      guarantorId,
      { action: dto.action as GuarantorWorkflowAction, notes: dto.reason.trim() },
      tenant.id,
      actor.id,
      req,
    );
  }

  private requireIdempotencyKey(req: Request): string {
    const key = (req.headers['x-idempotency-key'] as string | undefined) ?? (req.headers['idempotency-key'] as string | undefined);
    if (!key?.trim()) throw new BadRequestException('IDEMPOTENCY_KEY_REQUIRED');
    return key.trim();
  }

  private async resolveMemberId(userId: string, tenantId: string): Promise<string> {
    const member = await this.prisma.member.findFirst({ where: { tenantId, userId, isActive: true }, select: { id: true } });
    if (!member) throw new BadRequestException('MEMBER_PROFILE_NOT_FOUND');
    return member.id;
  }
}