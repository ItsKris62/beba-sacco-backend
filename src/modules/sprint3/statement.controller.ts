/**
 * Sprint 3 – Statement Controller
 *
 * GET /members/statement/fosa          – FOSA statement (JSON)
 * GET /members/statement/bosa          – BOSA statement (JSON)
 * GET /statements/export/pdf           – PDF export (server-side)
 */
import {
  Controller,
  Get,
  Query,
  Req,
  Res,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiResponse,
  ApiQuery,
} from '@nestjs/swagger';
import { IsOptional, IsString, IsEnum } from 'class-validator';
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
}

class PdfExportQueryDto extends StatementQueryDto {
  @IsEnum(['FOSA', 'BOSA'])
  type!: 'FOSA' | 'BOSA';
}

@ApiTags('Statements')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller()
export class StatementController {
  constructor(private readonly statementService: StatementService) {}

  @Get('members/statement/fosa')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Get FOSA statement',
    description:
      'Returns loan disbursements and repayments for the member. Requires STATEMENT_EXPORT consent.',
  })
  @ApiQuery({ name: 'memberId', required: false })
  @ApiQuery({ name: 'periodFrom', required: false, example: '2024-01-01' })
  @ApiQuery({ name: 'periodTo', required: false, example: '2024-12-31' })
  @ApiResponse({ status: 200, description: 'FOSA statement data' })
  @ApiResponse({ status: 403, description: 'STATEMENT_EXPORT consent required' })
  async getFosaStatement(
    @Query() query: StatementQueryDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<FosaStatement> {
    const memberId = query.memberId ?? req.user.memberId ?? '';
    return this.statementService.getFosaStatement(
      req.tenant.id,
      req.user.id,
      memberId,
      query.periodFrom,
      query.periodTo,
    );
  }

  @Get('members/statement/bosa')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Get BOSA statement',
    description:
      'Returns savings and welfare contributions for the member. Requires STATEMENT_EXPORT consent.',
  })
  @ApiQuery({ name: 'memberId', required: false })
  @ApiQuery({ name: 'periodFrom', required: false })
  @ApiQuery({ name: 'periodTo', required: false })
  @ApiResponse({ status: 200, description: 'BOSA statement data' })
  async getBosaStatement(
    @Query() query: StatementQueryDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<BosaStatement> {
    const memberId = query.memberId ?? req.user.memberId ?? '';
    return this.statementService.getBosaStatement(
      req.tenant.id,
      req.user.id,
      memberId,
      query.periodFrom,
      query.periodTo,
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
    @Query() query: PdfExportQueryDto,
    @Req() req: AuthenticatedRequest,
    @Res() res: Response,
  ): Promise<void> {
    const memberId = query.memberId ?? req.user.memberId ?? '';
    const saccoName = req.tenant.name;

    let statement: FosaStatement | BosaStatement;

    if (query.type === 'FOSA') {
      statement = await this.statementService.getFosaStatement(
        req.tenant.id,
        req.user.id,
        memberId,
        query.periodFrom,
        query.periodTo,
      );
    } else {
      statement = await this.statementService.getBosaStatement(
        req.tenant.id,
        req.user.id,
        memberId,
        query.periodFrom,
        query.periodTo,
      );
    }

    const pdfBuffer = await this.statementService.generatePdf(statement, saccoName, query.type);

    const filename = `${saccoName.replace(/\s+/g, '_')}_${query.type}_${statement.memberNumber}_${statement.periodFrom}_${statement.periodTo}.pdf`;

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': pdfBuffer.length,
      'X-Audit-Hash': statement.auditHash,
      'Cache-Control': 'no-store, no-cache, must-revalidate',
    });

    res.end(pdfBuffer);
  }
}
