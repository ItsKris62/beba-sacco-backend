import {
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiResponse, ApiTags, ApiHeader } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { UserRole } from '@prisma/client';
import { JwtAuthGuard } from '../../common/guards/jwt.guard';
import { StatementService, FosaStatement, BosaStatement } from './statement.service';
import type { AuthenticatedRequest } from '../../common/types/request.types';

class StatementQueryDto {
  @IsOptional()
  @IsString()
  memberId?: string;

  @IsOptional()
  @IsString()
  periodFrom?: string;

  @IsOptional()
  @IsString()
  periodTo?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;
}

class StatementExportQueryDto extends StatementQueryDto {
  @IsEnum(['FOSA', 'BOSA'])
  type!: 'FOSA' | 'BOSA';
}

const STAFF_STATEMENT_ROLES = new Set<UserRole>([
  UserRole.SUPER_ADMIN,
  UserRole.TENANT_ADMIN,
  UserRole.MANAGER,
  UserRole.AUDITOR,
]);

@ApiTags('Statements')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@ApiHeader({ name: 'X-Tenant-ID', description: 'Tenant identifier for multi-tenancy', required: true })
@Controller()
export class StatementController {
  constructor(private readonly statementService: StatementService) {}

  @Get('members/statement/fosa')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Get FOSA statement',
    description:
      'Returns loan disbursements and repayments for the member. Member self-service requires STATEMENT_EXPORT consent; admin, manager, super admin, and auditor may generate tenant-scoped member statements.',
  })
  @ApiQuery({ name: 'memberId', required: false })
  @ApiQuery({ name: 'periodFrom', required: false, example: '2024-01-01' })
  @ApiQuery({ name: 'periodTo', required: false, example: '2024-12-31' })
  @ApiQuery({ name: 'page', required: false, type: Number, example: 1 })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 20 })
  @ApiResponse({ status: 200, description: 'FOSA statement data' })
  @ApiResponse({ status: 403, description: 'STATEMENT_EXPORT consent required or forbidden member scope' })
  async getFosaStatement(
    @Query() query: StatementQueryDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<FosaStatement> {
    const { memberId, skipConsent } = await this.resolveStatementScope(req, query.memberId);
    return this.statementService.getFosaStatement(
      req.tenant.id,
      req.user.id,
      memberId,
      query.periodFrom,
      query.periodTo,
      { skipConsent, exportFormat: 'VIEW', ipAddress: req.ip, page: query.page, limit: query.limit },
    );
  }

  @Get('members/statement/bosa')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Get BOSA statement',
    description:
      'Returns savings and welfare contributions for the member. Member self-service requires STATEMENT_EXPORT consent; admin, manager, super admin, and auditor may generate tenant-scoped member statements.',
  })
  @ApiQuery({ name: 'memberId', required: false })
  @ApiQuery({ name: 'periodFrom', required: false })
  @ApiQuery({ name: 'periodTo', required: false })
  @ApiQuery({ name: 'page', required: false, type: Number, example: 1 })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 20 })
  @ApiResponse({ status: 200, description: 'BOSA statement data' })
  async getBosaStatement(
    @Query() query: StatementQueryDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<BosaStatement> {
    const { memberId, skipConsent } = await this.resolveStatementScope(req, query.memberId);
    return this.statementService.getBosaStatement(
      req.tenant.id,
      req.user.id,
      memberId,
      query.periodFrom,
      query.periodTo,
      { skipConsent, exportFormat: 'VIEW', ipAddress: req.ip, page: query.page, limit: query.limit },
    );
  }

  @Get('statements/export/pdf')
  @ApiOperation({
    summary: 'Export statement as PDF',
    description:
      'Generates a server-side PDF with watermark, transaction table, audit hash, and ODPC disclaimer.',
  })
  @ApiQuery({ name: 'type', enum: ['FOSA', 'BOSA'], required: true })
  @ApiQuery({ name: 'memberId', required: false })
  @ApiQuery({ name: 'periodFrom', required: false })
  @ApiQuery({ name: 'periodTo', required: false })
  @ApiResponse({ status: 200, description: 'PDF file stream' })
  async exportPdf(
    @Query() query: StatementExportQueryDto,
    @Req() req: AuthenticatedRequest,
    @Res() res: Response,
  ): Promise<void> {
    const statement = await this.buildStatement(req, query, 'PDF');
    const saccoName = req.tenant.name;
    const pdfBuffer = await this.statementService.generatePdf(statement, saccoName, query.type);
    const filename = this.statementFilename(saccoName, query.type, statement, 'pdf');

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': pdfBuffer.length,
      'X-Audit-Hash': statement.auditHash,
      'Cache-Control': 'no-store, no-cache, must-revalidate',
    });
    res.end(pdfBuffer);
  }

  @Get('statements/export/csv')
  @ApiOperation({ summary: 'Export statement as CSV' })
  @ApiQuery({ name: 'type', enum: ['FOSA', 'BOSA'], required: true })
  @ApiQuery({ name: 'memberId', required: false })
  @ApiQuery({ name: 'periodFrom', required: false })
  @ApiQuery({ name: 'periodTo', required: false })
  @ApiResponse({ status: 200, description: 'CSV file stream' })
  async exportCsv(
    @Query() query: StatementExportQueryDto,
    @Req() req: AuthenticatedRequest,
    @Res() res: Response,
  ): Promise<void> {
    const statement = await this.buildStatement(req, query, 'CSV');
    const csv = this.statementService.exportAsCsv(statement);
    const filename = this.statementFilename(req.tenant.name, query.type, statement, 'csv');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('X-Audit-Hash', statement.auditHash);
    res.send(csv);
  }

  private async buildStatement(
    req: AuthenticatedRequest,
    query: StatementExportQueryDto,
    exportFormat: 'PDF' | 'CSV',
  ): Promise<FosaStatement | BosaStatement> {
    const { memberId, skipConsent } = await this.resolveStatementScope(req, query.memberId);
    if (query.type === 'FOSA') {
      return this.statementService.getFosaStatement(
        req.tenant.id,
        req.user.id,
        memberId,
        query.periodFrom,
        query.periodTo,
        { skipConsent, exportFormat, ipAddress: req.ip },
      );
    }

    return this.statementService.getBosaStatement(
      req.tenant.id,
      req.user.id,
      memberId,
      query.periodFrom,
      query.periodTo,
      { skipConsent, exportFormat, ipAddress: req.ip },
    );
  }

  private async resolveStatementScope(
    req: AuthenticatedRequest,
    requestedMemberId?: string,
  ): Promise<{ memberId: string; skipConsent: boolean }> {
    const isStaff = STAFF_STATEMENT_ROLES.has(req.user.role);
    if (isStaff && requestedMemberId) {
      return { memberId: requestedMemberId, skipConsent: true };
    }

    const ownMemberId = await this.statementService.resolveMemberIdForUser(req.tenant.id, req.user.id);
    if (requestedMemberId && requestedMemberId !== ownMemberId) {
      throw new ForbiddenException('You can only generate statements for your own member profile');
    }

    return { memberId: ownMemberId, skipConsent: false };
  }

  private statementFilename(
    saccoName: string,
    type: 'FOSA' | 'BOSA',
    statement: FosaStatement | BosaStatement,
    extension: 'pdf' | 'csv',
  ): string {
    return `${saccoName.replace(/\s+/g, '_')}_${type}_${statement.memberNumber}_${statement.periodFrom}_${statement.periodTo}.${extension}`;
  }
}
