import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiHeader,
  ApiOperation,
  ApiParam,
  ApiProperty,
  ApiPropertyOptional,
  ApiResponse,
  ApiSecurity,
  ApiTags,
} from '@nestjs/swagger';
import { IsBoolean, IsEnum, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { Request } from 'express';
import { UserRole } from '@prisma/client';
import { GuarantorResponseService, GuarantorWorkflowAction } from './guarantor-response.service';
import { PrismaService } from '../prisma/prisma.service';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentTenant } from '../common/decorators/current-tenant.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../modules/auth/strategies/jwt.strategy';
import type { Tenant } from '@prisma/client';

enum GuarantorDecision {
  ACCEPT = 'ACCEPT',
  DECLINE = 'DECLINE',
}

class GuarantorActionDto {
  @ApiProperty({ enum: GuarantorDecision, example: GuarantorDecision.ACCEPT })
  @IsEnum(GuarantorDecision)
  action!: GuarantorDecision;

  @ApiPropertyOptional({ example: 'I agree to guarantee this loan.' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}

class GuarantorResponseDto extends GuarantorActionDto {
  @ApiProperty({
    description:
      'Frontend confirmation checkbox that the member has been shown and understands the liability disclosure ' +
      '(their savings can be drawn on default). Required when accepting.',
  })
  @IsNotEmpty()
  @IsBoolean()
  digitalAcknowledgment!: boolean;
}

class AdminGuarantorOverrideDto extends GuarantorActionDto {
  @ApiProperty({ example: 'Verified signed consent at branch office.' })
  @IsString()
  @MaxLength(1000)
  reason!: string;

  // Admin overrides carry the mandatory `reason` above as their compliance record instead —
  // the member did not click through the in-app disclosure, so this is not required here.
  @ApiPropertyOptional({ description: 'Not required for admin overrides.' })
  @IsOptional()
  @IsBoolean()
  digitalAcknowledgment?: boolean;
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
  @ApiOperation({
    summary: 'Accept or decline a loan guarantor request',
    description:
      'Only the authenticated member linked to the pending guarantor request may respond. ' +
      'ACCEPT places the guarantor savings hold. When required guarantor count and coverage are met, ' +
      'the loan moves from PENDING_GUARANTORS to PENDING_APPROVAL.',
  })
  @ApiHeader({ name: 'X-Idempotency-Key', required: true })
  @ApiParam({ name: 'id', description: 'Loan UUID' })
  @ApiResponse({ status: 200, description: 'Guarantor response recorded' })
  @ApiResponse({
    status: 400,
    description: 'Invalid action, expired request, or eligibility failure',
  })
  @ApiResponse({ status: 403, description: 'Authenticated member is not the requested guarantor' })
  @ApiResponse({ status: 404, description: 'Guarantor request not found' })
  @ApiResponse({ status: 409, description: 'Duplicate or already-processed guarantor response' })
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
      {
        action: dto.action as GuarantorWorkflowAction,
        notes: dto.notes,
        digitalAcknowledgment: dto.digitalAcknowledgment,
      },
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
  @ApiParam({ name: 'loanId', description: 'Loan UUID' })
  @ApiParam({ name: 'guarantorId', description: 'LoanGuarantor UUID or guarantor member UUID' })
  @ApiResponse({ status: 200, description: 'Guarantor status overridden' })
  @ApiResponse({ status: 400, description: 'Override reason is required' })
  @ApiResponse({ status: 404, description: 'Guarantor request not found' })
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
      {
        action: dto.action as GuarantorWorkflowAction,
        notes: dto.reason.trim(),
        digitalAcknowledgment: dto.digitalAcknowledgment,
      },
      tenant.id,
      actor.id,
      req,
    );
  }

  private requireIdempotencyKey(req: Request): string {
    const key =
      (req.headers['x-idempotency-key'] as string | undefined) ??
      (req.headers['idempotency-key'] as string | undefined);
    if (!key?.trim()) throw new BadRequestException('IDEMPOTENCY_KEY_REQUIRED');
    return key.trim();
  }

  private async resolveMemberId(userId: string, tenantId: string): Promise<string> {
    const member = await this.prisma.member.findFirst({
      where: { tenantId, userId, isActive: true },
      select: { id: true },
    });
    if (!member) throw new BadRequestException('MEMBER_PROFILE_NOT_FOUND');
    return member.id;
  }
}
