import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Query,
  Req,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiHeader,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiSecurity,
  ApiTags,
} from '@nestjs/swagger';
import { DocumentStatus, UserRole } from '@prisma/client';
import { Request } from 'express';
import { CurrentTenant } from '../../common/decorators/current-tenant.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import type { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import type { Tenant } from '@prisma/client';
import { DocumentsService } from './documents.service';
import { ReviewDocumentDto } from './dto/document.dto';

@ApiTags('KYC Documents')
@ApiBearerAuth()
@ApiSecurity('X-Tenant-ID')
@ApiHeader({ name: 'X-Tenant-ID', required: true, description: 'Tenant UUID' })
@Controller('admin/kyc/documents')
export class AdminDocumentsController {
  constructor(private readonly documents: DocumentsService) {}

  @Get()
  @Roles(UserRole.MEMBER)
  @ApiOperation({
    summary: 'List tenant-scoped KYC documents',
    description: 'Service-level permissions allow TENANT_ADMIN, MANAGER, CHAIRMAN, LOAN_OFFICER, and AUDITOR to view.',
  })
  @ApiQuery({ name: 'status', required: false, enum: DocumentStatus })
  @ApiQuery({ name: 'memberId', required: false, type: String })
  @ApiResponse({ status: 200, description: 'KYC document queue' })
  listDocuments(
    @CurrentTenant() tenant: Tenant,
    @CurrentUser() actor: AuthenticatedUser,
    @Query('status') status?: DocumentStatus,
    @Query('memberId') memberId?: string,
  ) {
    return this.documents.listAdminDocuments(tenant.id, actor, { status, memberId });
  }

  @Get(':id/download')
  @Roles(UserRole.MEMBER)
  @ApiOperation({ summary: 'Generate a short-lived download URL for staff review' })
  @ApiResponse({ status: 200, description: 'Pre-signed download URL' })
  getDownloadUrl(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentTenant() tenant: Tenant,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.documents.getAdminDownloadUrl(tenant.id, actor, id, req.ip);
  }

  @Patch(':id/review')
  @Roles(UserRole.MEMBER)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Approve or reject a KYC document',
    description: 'Only MANAGER and CHAIRMAN may approve or reject, enforced inside the service as exact-role policy.',
  })
  @ApiResponse({ status: 200, description: 'Document review recorded' })
  reviewDocument(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReviewDocumentDto,
    @CurrentTenant() tenant: Tenant,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.documents.reviewDocument(tenant.id, actor, id, dto, req.ip);
  }
}
