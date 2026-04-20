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

import { PrismaModule } from '../../prisma/prisma.module';
import { AuditModule } from '../audit/audit.module';

const IMPORT_QUEUE = 'data.import';

@Module({
  imports: [
    PrismaModule,
    AuditModule,
    // Register the import queue
    BullModule.registerQueue({ name: IMPORT_QUEUE }),
    // Use memory storage so we can access file.buffer in the controller
    MulterModule.register({ storage: memoryStorage() }),
  ],
  controllers: [DataImportController],
  providers: [
    DataImportService,
    CsvParserService,
    ImportValidationService,
    ImportExecutionService,
    ImportProcessor,
  ],
  exports: [DataImportService],
})
export class DataImportModule {}
