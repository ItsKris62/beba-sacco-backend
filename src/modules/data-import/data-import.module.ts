import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { MulterModule } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';

import { DataImportController } from './data-import.controller';
import { DataImportService } from './data-import.service';
import { CsvParserService } from './csv-parser.service';
import { ImportValidationService } from './import-validation.service';
import { ImportExecutionService } from './import-execution.service';
import { ImportProcessor } from './processors/import.processor';
import { FinancialImportController } from './financial-import.controller';
import { FinancialImportService } from './financial-import.service';

import { PrismaModule } from '../../prisma/prisma.module';
import { AuditModule } from '../audit/audit.module';
import { CommonServicesModule } from '../../common/services/common-services.module';

const IMPORT_QUEUE = 'data.import';

@Module({
  imports: [
    PrismaModule,
    AuditModule,
    CommonServicesModule,
    BullModule.registerQueue({ name: IMPORT_QUEUE }),
    MulterModule.register({ storage: memoryStorage() }),
  ],
  controllers: [DataImportController, FinancialImportController],
  providers: [
    DataImportService,
    CsvParserService,
    ImportValidationService,
    ImportExecutionService,
    ImportProcessor,
    FinancialImportService,
  ],
  exports: [DataImportService, FinancialImportService],
})
export class DataImportModule {}
