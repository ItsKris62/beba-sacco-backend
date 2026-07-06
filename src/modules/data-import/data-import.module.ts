import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';

import { DataImportService } from './data-import.service';
import { CsvParserService } from './csv-parser.service';
import { ImportValidationService } from './import-validation.service';
import { ImportExecutionService } from './import-execution.service';
import { ImportProcessor } from './processors/import.processor';
import { FinancialImportService } from './financial-import.service';

import { PrismaModule } from '../../prisma/prisma.module';
import { AuditModule } from '../audit/audit.module';
import { CommonServicesModule } from '../../common/services/common-services.module';
import { SmsModule } from '../sms/sms.module';
import { isWorkerRuntime } from '../queue/worker-runtime';

const IMPORT_QUEUE = 'data.import';
const DATA_IMPORT_WORKER_PROVIDERS = isWorkerRuntime() ? [ImportProcessor] : [];

@Module({
  imports: [
    PrismaModule,
    AuditModule,
    CommonServicesModule,
    SmsModule,
    BullModule.registerQueue({ name: IMPORT_QUEUE }),
  ],
  providers: [
    DataImportService,
    CsvParserService,
    ImportValidationService,
    ImportExecutionService,
    ...DATA_IMPORT_WORKER_PROVIDERS,
    FinancialImportService,
  ],
  exports: [DataImportService, FinancialImportService],
})
export class DataImportModule {}
