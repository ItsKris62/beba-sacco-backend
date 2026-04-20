import {
  Controller, Post, Get, Param, Body,
  UseInterceptors, UploadedFile, HttpCode, HttpStatus,
  Req, BadRequestException, NotFoundException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiTags, ApiBearerAuth, ApiSecurity, ApiOperation,
  ApiResponse, ApiConsumes, ApiBody, ApiHeader,
} from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { Request } from 'express';
import { DataImportService } from './data-import.service';
import { ExecuteImportDto, RetryFailedDto } from './dto/import.dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { CurrentTenant } from '../../common/decorators/current-tenant.decorator';
import type { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import type { Tenant } from '@prisma/client';

@ApiTags('Data Import (Sprint 2)')
@ApiBearerAuth()
@ApiSecurity('X-Tenant-ID')
@ApiHeader({ name: 'X-Tenant-ID', required: true, description: 'Tenant UUID' })
@Controller('admin/data-import')
export class DataImportController {
  constructor(private readonly dataImportService: DataImportService) {}

  // ─── PREVIEW ─────────────────────────────────────────────────────────────────

  @Post('preview')
  @Roles(UserRole.TENANT_ADMIN, UserRole.MANAGER)
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
      fileFilter: (_req, file, cb) => {
        if (!file.originalname.match(/\.(csv|CSV)$/)) {
          return cb(new BadRequestException('Only CSV files are accepted'), false);
        }
        cb(null, true);
      },
    }),
  )
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: { type: 'string', format: 'binary', description: 'CSV file to import' },
        wardId: { type: 'string', description: 'Ward UUID to assign members to' },
      },
      required: ['file', 'wardId'],
    },
  })
  @ApiOperation({
    summary: 'Upload CSV → validate → return preview report (no DB writes)',
    description:
      'Parses the CSV, validates each row, checks for duplicates and phone/ID issues. ' +
      'Returns a preview report with per-row status. No data is written to the database.',
  })
  @ApiResponse({ status: 200, description: 'Preview report with validation results' })
  @ApiResponse({ status: 400, description: 'Invalid file format or missing wardId' })
  async preview(
    @UploadedFile() file: Express.Multer.File,
    @Body('wardId') wardId: string,
    @CurrentTenant() tenant: Tenant,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    if (!file) throw new BadRequestException('No file uploaded');
    if (!wardId) throw new BadRequestException('wardId is required');

    return this.dataImportService.preview(file, wardId, tenant.id, actor.id);
  }

  // ─── EXECUTE ─────────────────────────────────────────────────────────────────

  @Post('execute')
  @Roles(UserRole.TENANT_ADMIN, UserRole.MANAGER)
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Execute approved import → queue BullMQ job → return jobId',
    description:
      'Queues the import job for async processing. Rate-limited to 1 job per tenant per 10 minutes. ' +
      'Poll /jobs/:jobId for status.',
  })
  @ApiResponse({ status: 202, description: 'Import job queued successfully' })
  @ApiResponse({ status: 400, description: 'Import log not found or not in previewable state' })
  @ApiResponse({ status: 429, description: 'Rate limit: 1 import per tenant per 10 minutes' })
  async execute(
    @Body() dto: ExecuteImportDto,
    @CurrentTenant() tenant: Tenant,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.dataImportService.execute(dto, tenant.id, actor.id);
  }

  // ─── JOB STATUS ──────────────────────────────────────────────────────────────

  @Get('jobs/:jobId')
  @Roles(UserRole.TENANT_ADMIN, UserRole.MANAGER, UserRole.AUDITOR)
  @ApiOperation({ summary: 'Poll job status: queued → processing → completed/failed' })
  @ApiResponse({ status: 200, description: 'Job status and progress' })
  @ApiResponse({ status: 404, description: 'Job not found' })
  async getJobStatus(
    @Param('jobId') jobId: string,
    @CurrentTenant() tenant: Tenant,
  ) {
    return this.dataImportService.getJobStatus(jobId, tenant.id);
  }

  // ─── JOB REPORT ──────────────────────────────────────────────────────────────

  @Get('jobs/:jobId/report')
  @Roles(UserRole.TENANT_ADMIN, UserRole.MANAGER, UserRole.AUDITOR)
  @ApiOperation({ summary: 'Download detailed report: success count, failed rows with reasons' })
  @ApiResponse({ status: 200, description: 'Detailed import report' })
  @ApiResponse({ status: 404, description: 'Job not found' })
  async getJobReport(
    @Param('jobId') jobId: string,
    @CurrentTenant() tenant: Tenant,
  ) {
    return this.dataImportService.getJobReport(jobId, tenant.id);
  }

  // ─── HISTORY ─────────────────────────────────────────────────────────────────

  @Get('history')
  @Roles(UserRole.TENANT_ADMIN, UserRole.MANAGER, UserRole.AUDITOR)
  @ApiOperation({ summary: 'List all past import jobs for this tenant' })
  @ApiResponse({ status: 200, description: 'Paginated list of import jobs' })
  async getHistory(@CurrentTenant() tenant: Tenant) {
    return this.dataImportService.getHistory(tenant.id);
  }

  // ─── RETRY FAILED ────────────────────────────────────────────────────────────

  @Post('retry-failed')
  @Roles(UserRole.TENANT_ADMIN, UserRole.MANAGER)
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Retry only failed records from a completed job' })
  @ApiResponse({ status: 202, description: 'Retry job queued' })
  @ApiResponse({ status: 404, description: 'Import log not found' })
  async retryFailed(
    @Body() dto: RetryFailedDto,
    @CurrentTenant() tenant: Tenant,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.dataImportService.retryFailed(dto, tenant.id, actor.id);
  }
}
