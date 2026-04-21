/**
 * Sprint 3 – Financial Import Controller
 *
 * POST /admin/data-import/financial-preview  – validate CSV rows, return preview
 * POST /admin/data-import/execute-financial  – execute import into DB
 *
 * Roles: TENANT_ADMIN, MANAGER
 */
import {
  Controller,
  Post,
  Body,
  UploadedFile,
  UseInterceptors,
  UseGuards,
  Req,
  HttpCode,
  HttpStatus,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiTags,
  ApiOperation,
  ApiConsumes,
  ApiBody,
  ApiBearerAuth,
  ApiResponse,
} from '@nestjs/swagger';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { JwtAuthGuard } from '../../common/guards/jwt.guard';
import { FinancialImportService } from './financial-import.service';
import {
  FinancialPreviewRequestDto,
  FinancialPreviewResponseDto,
  FinancialExecuteRequestDto,
  FinancialExecuteResponseDto,
} from './dto/financial-import.dto';
import type { RequestWithTenant } from '../../common/interceptors/tenant.interceptor';

@ApiTags('Financial Import')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('admin/data-import')
export class FinancialImportController {
  constructor(private readonly financialImportService: FinancialImportService) {}

  /**
   * POST /admin/data-import/financial-preview
   * Upload a CSV file + specify sheet type → returns row-level validation preview
   */
  @Post('financial-preview')
  @HttpCode(HttpStatus.OK)
  @Roles('TENANT_ADMIN', 'MANAGER')
  @UseInterceptors(FileInterceptor('file'))
  @ApiOperation({
    summary: 'Preview financial CSV import',
    description:
      'Validates CSV rows against existing members/loans. Returns per-row status (VALID/WARNING/ERROR) without writing to DB.',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: { type: 'string', format: 'binary' },
        sheetType: {
          type: 'string',
          enum: ['LOAN_DISBURSEMENT', 'LOAN_REPAYMENT', 'SACCO_SAVINGS', 'GROUP_WELFARE'],
        },
      },
    },
  })
  @ApiResponse({ status: 200, type: FinancialPreviewResponseDto })
  async previewFinancialImport(
    @UploadedFile() file: Express.Multer.File,
    @Body() dto: FinancialPreviewRequestDto,
    @Req() req: RequestWithTenant,
  ): Promise<FinancialPreviewResponseDto> {
    if (!file) {
      throw new BadRequestException('CSV file is required');
    }

    const rows = this.parseCsvBuffer(file.buffer);
    return this.financialImportService.previewFinancialSheet(
      req.tenant.id,
      dto.sheetType,
      rows,
    );
  }

  /**
   * POST /admin/data-import/execute-financial
   * Upload a CSV file + specify sheet type → execute import into DB
   */
  @Post('execute-financial')
  @HttpCode(HttpStatus.OK)
  @Roles('TENANT_ADMIN', 'MANAGER')
  @UseInterceptors(FileInterceptor('file'))
  @ApiOperation({
    summary: 'Execute financial CSV import',
    description:
      'Parses and persists loan disbursements, repayments, savings records, or group welfare collections. Idempotent – duplicate rows are skipped.',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: { type: 'string', format: 'binary' },
        sheetType: {
          type: 'string',
          enum: ['LOAN_DISBURSEMENT', 'LOAN_REPAYMENT', 'SACCO_SAVINGS', 'GROUP_WELFARE'],
        },
        importBatchId: { type: 'string', description: 'Optional batch ID for linking to DataImportLog' },
      },
    },
  })
  @ApiResponse({ status: 200, type: FinancialExecuteResponseDto })
  async executeFinancialImport(
    @UploadedFile() file: Express.Multer.File,
    @Body() dto: FinancialExecuteRequestDto,
    @Req() req: RequestWithTenant,
  ): Promise<FinancialExecuteResponseDto> {
    if (!file) {
      throw new BadRequestException('CSV file is required');
    }

    const rows = this.parseCsvBuffer(file.buffer);
    const userId = (req as RequestWithTenant & { user: { id: string } }).user.id;

    return this.financialImportService.executeFinancialImport(
      req.tenant.id,
      userId,
      dto.sheetType,
      rows,
      dto.importBatchId,
    );
  }

  // ─── CSV Parser ────────────────────────────────────────────────────────────

  /**
   * Minimal CSV parser – handles comma-separated values with optional header row.
   * For production use, replace with papaparse or csv-parse.
   */
  private parseCsvBuffer(buffer: Buffer): Record<string, unknown>[] {
    const text = buffer.toString('utf-8');
    const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);

    if (lines.length < 2) return [];

    const headers = lines[0].split(',').map((h) => h.trim().replace(/^"|"$/g, ''));
    const rows: Record<string, unknown>[] = [];

    for (let i = 1; i < lines.length; i++) {
      const values = lines[i].split(',').map((v) => v.trim().replace(/^"|"$/g, ''));
      const row: Record<string, unknown> = {};
      headers.forEach((header, idx) => {
        const val = values[idx] ?? '';
        // Auto-coerce numeric fields
        row[header] = isNaN(Number(val)) || val === '' ? val : Number(val);
      });
      rows.push(row);
    }

    return rows;
  }
}
