import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Query,
  ParseIntPipe,
  DefaultValuePipe,
  HttpCode,
  HttpStatus,
  ParseUUIDPipe,
} from '@nestjs/common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiSecurity,
  ApiOperation,
  ApiResponse,
  ApiQuery,
  ApiParam,
  ApiHeader,
} from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { SkipThrottle } from '@nestjs/throttler';
import { Roles } from '../../../common/decorators/roles.decorator';
import { AdminHealthService } from './admin-health.service';

@ApiTags('Admin – System Health')
@ApiBearerAuth()
@ApiSecurity('X-Tenant-ID')
@ApiHeader({ name: 'X-Tenant-ID', required: true, description: 'Tenant UUID' })
@SkipThrottle()
@Roles(UserRole.SUPER_ADMIN)
@Controller('admin/health')
export class AdminHealthController {
  constructor(private readonly healthService: AdminHealthService) {}

  // ─── Service Status ──────────────────────────────────────────────

  @Get('services')
  @ApiOperation({
    summary: 'Real-time service status with latency',
    description:
      'Returns live status for Core Banking API, PostgreSQL, Redis, and M-Pesa Gateway. ' +
      'Results are cached for 10 seconds to prevent hammering downstream services.',
  })
  @ApiResponse({ status: 200, description: 'Service status array' })
  getServicesHealth() {
    return this.healthService.getServicesHealth();
  }

  @Post('services/:serviceId/test')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Test individual service connectivity (bypasses cache)' })
  @ApiParam({ name: 'serviceId', enum: ['core-banking', 'database', 'redis', 'mpesa'] })
  @ApiResponse({ status: 200, description: 'Test result with real latency' })
  testService(@Param('serviceId') serviceId: string) {
    return this.healthService.testService(serviceId);
  }

  // ─── Error Logs ──────────────────────────────────────────────────

  @Get('error-logs')
  @ApiOperation({
    summary: 'System error logs from audit trail',
    description: 'Queries the AuditLog table for error-level events over the last 7 days.',
  })
  @ApiQuery({ name: 'level', required: false, enum: ['all', 'INFO', 'WARN', 'ERROR', 'FATAL'] })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiResponse({ status: 200, description: 'Paginated error log entries' })
  getErrorLogs(
    @Query('level') level?: string,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page?: number,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit?: number,
  ) {
    return this.healthService.getErrorLogs({ level, page, limit });
  }

  // ─── Background Jobs ─────────────────────────────────────────────

  @Get('background-jobs')
  @ApiOperation({
    summary: 'BullMQ queue status for all monitored queues',
    description: 'Returns real-time job counts (waiting/active/completed/failed) from BullMQ.',
  })
  @ApiResponse({ status: 200, description: 'Array of queue job counts' })
  getBackgroundJobs() {
    return this.healthService.getBackgroundJobs();
  }

  // ─── Blocked IPs ─────────────────────────────────────────────────

  @Get('blocked-ips')
  @ApiOperation({ summary: 'List actively blocked IP addresses' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiResponse({ status: 200, description: 'Paginated list of blocked IPs' })
  getBlockedIPs(
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page?: number,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit?: number,
  ) {
    return this.healthService.getBlockedIPs({ page, limit });
  }

  @Delete('blocked-ips/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Unblock an IP address' })
  @ApiParam({ name: 'id', description: 'BlockedIP record UUID' })
  @ApiResponse({ status: 204, description: 'IP unblocked successfully' })
  unblockIP(@Param('id', ParseUUIDPipe) id: string) {
    return this.healthService.unblockIP(id);
  }

  // ─── Failed Logins ────────────────────────────────────────────────

  @Get('failed-logins')
  @ApiOperation({
    summary: 'Failed login attempts in the last hour',
    description:
      'Aggregates AUTH.LOGIN.FAILED audit log entries from the last 60 minutes, ' +
      'grouped by IP address and username. Sorted by attempt count (highest first).',
  })
  @ApiResponse({ status: 200, description: 'Array of failed login attempt summaries' })
  getFailedLogins() {
    return this.healthService.getFailedLogins();
  }
}
