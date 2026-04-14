import {
  Controller, Get, Post, Param, Body, Query,
  HttpCode, HttpStatus, ParseUUIDPipe, Req,
} from '@nestjs/common';
import {
  ApiTags, ApiBearerAuth, ApiSecurity, ApiOperation,
  ApiResponse, ApiQuery, ApiHeader,
} from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { Request } from 'express';
import { MemberPortalService } from './member-portal.service';
import { MemberLoanApplyDto } from './dto/member-loan-apply.dto';
import { MemberStkPushDto } from './dto/member-stk-push.dto';
import { RequestUploadUrlDto, UploadUrlResponseDto } from './dto/upload-url.dto';
import { GuarantorResponseDto } from '../loans/dto/guarantor-response.dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { CurrentTenant } from '../../common/decorators/current-tenant.decorator';
import type { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import type { Tenant } from '@prisma/client';

@ApiTags('Member Portal')
@ApiBearerAuth()
@ApiSecurity('X-Tenant-ID')
@ApiHeader({ name: 'X-Tenant-ID', required: true, description: 'Tenant UUID' })
@Roles(UserRole.MEMBER)
@Controller('members')
export class MemberPortalController {
  constructor(private readonly portal: MemberPortalService) {}

  // ─── DASHBOARD ────────────────────────────────────────────────

  @Get('dashboard')
  @ApiOperation({
    summary: 'Member dashboard',
    description: 'Returns FOSA/BOSA balances, active loans, recent transactions, and pending guarantor requests.',
  })
  @ApiResponse({ status: 200, description: 'Dashboard data' })
  getDashboard(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentTenant() tenant: Tenant,
  ) {
    return this.portal.getDashboard(user.id, tenant.id);
  }

  // ─── FOSA STATEMENT ──────────────────────────────────────────

  @Get('accounts/fosa/statement')
  @ApiOperation({ summary: 'Paginated FOSA account statement with running balance' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'from', required: false, type: String, description: 'ISO date (YYYY-MM-DD)' })
  @ApiQuery({ name: 'to', required: false, type: String, description: 'ISO date (YYYY-MM-DD)' })
  getFosaStatement(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentTenant() tenant: Tenant,
    @Query('page') page = 1,
    @Query('limit') limit = 20,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.portal.getFosaStatement(user.id, tenant.id, +page, +limit, from, to);
  }

  // ─── LOAN APPLICATION ─────────────────────────────────────────

  @Post('loans/apply')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Apply for a loan (member self-service)',
    description: 'Member applies for a loan on their own behalf. Eligibility validated against FOSA/BOSA balances.',
  })
  @ApiResponse({ status: 201, description: 'Loan application submitted' })
  applyForLoan(
    @Body() dto: MemberLoanApplyDto,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentTenant() tenant: Tenant,
    @Req() req: Request,
  ) {
    return this.portal.applyForLoan(user.id, dto, tenant.id, req.ip);
  }

  // ─── GUARANTOR RESPONSE ───────────────────────────────────────

  @Post('loans/:loanId/guarantor-response')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Accept or decline a guarantor invitation' })
  @ApiResponse({ status: 200, description: 'Guarantor response recorded' })
  respondToGuarantor(
    @Param('loanId', ParseUUIDPipe) loanId: string,
    @Body() dto: GuarantorResponseDto,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentTenant() tenant: Tenant,
    @Req() req: Request,
  ) {
    return this.portal.respondToGuarantor(user.id, loanId, dto, tenant.id, req.ip);
  }

  // ─── MPESA DEPOSIT ────────────────────────────────────────────

  @Post('deposit/mpesa')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Initiate M-Pesa STK Push deposit to member FOSA',
    description: 'Sends a payment prompt to the specified phone number. Amount is credited to member FOSA on successful callback.',
  })
  @ApiResponse({ status: 200, description: 'STK Push initiated' })
  initiateDeposit(
    @Body() dto: MemberStkPushDto,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentTenant() tenant: Tenant,
    @Req() req: Request,
  ) {
    return this.portal.initiateDeposit(user.id, dto.phone, dto.amount, tenant.id, req.ip);
  }

  // ─── DOCUMENT UPLOAD ─────────────────────────────────────────

  @Post('documents/upload-url')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Request a pre-signed PUT URL for direct document upload',
    description:
      'Returns a signed PUT URL (valid 5 min) for uploading a document directly to object storage. ' +
      'After a successful upload, persist the returned `objectKey` on the relevant record.',
  })
  @ApiResponse({ status: 200, type: UploadUrlResponseDto, description: 'Pre-signed upload URL' })
  @ApiResponse({ status: 400, description: 'Unsupported content type' })
  async requestUploadUrl(
    @Body() dto: RequestUploadUrlDto,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentTenant() tenant: Tenant,
  ): Promise<UploadUrlResponseDto> {
    return this.portal.requestUploadUrl({
      tenantId: tenant.id,
      userId: user.id,
      fileName: dto.fileName,
      contentType: dto.contentType,
    });
  }
}
