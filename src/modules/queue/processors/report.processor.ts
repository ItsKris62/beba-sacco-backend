import { InjectQueue, OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import { ReportsService } from '../../reports/reports.service';
import { StorageService } from '../../storage/storage.service';
import { AuditService } from '../../audit/audit.service';
import { QUEUE_NAMES, ReportGenerationJobPayload } from '../queue.constants';

@Processor(QUEUE_NAMES.REPORT_GENERATION, { concurrency: 3 })
export class ReportProcessor extends WorkerHost {
  private readonly logger = new Logger(ReportProcessor.name);

  constructor(
    private readonly reports: ReportsService,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
    @InjectQueue(QUEUE_NAMES.REPORT_GENERATION_DLQ)
    private readonly dlq: Queue<ReportGenerationJobPayload>,
  ) {
    super();
  }

  async process(job: Job<ReportGenerationJobPayload>): Promise<void> {
    const payload = job.data;
    await this.reports.markRunning(payload.jobId, payload.tenantId);

    const report = await this.reports.buildReport(payload);
    const objectKey = `tenants/${payload.tenantId}/reports/${payload.jobId}.${payload.format.toLowerCase()}`;
    await this.storage.uploadBuffer(objectKey, report.buffer, report.contentType);
    await this.reports.markSucceeded(payload.jobId, payload.tenantId, objectKey);

    await this.audit.create({
      tenantId: payload.tenantId,
      actorId: payload.requestedBy,
      action: 'REPORT.GENERATED',
      entityType: 'ReportJob',
      entityId: payload.jobId,
      oldValue: { status: 'RUNNING' },
      newValue: { status: 'SUCCEEDED', objectKey },
      metadata: { type: payload.type, format: payload.format },
    });
  }

  @OnWorkerEvent('failed')
  async failed(job: Job<ReportGenerationJobPayload> | undefined, error: Error): Promise<void> {
    if (!job) return;
    const payload = job.data;
    await this.reports.markFailed(payload.jobId, payload.tenantId, error.message);
    await this.dlq.add('failed', payload, { attempts: 1, removeOnComplete: { age: 604800, count: 50 }, removeOnFail: { age: 2592000, count: 50 } });
    this.logger.error(`Report job ${payload.jobId} failed: ${error.message}`, error.stack);
  }
}
