/**
 * Sprint 3 – Main Module
 *
 * Registers all Sprint 3 services and controllers:
 * - FinancialImportController / FinancialImportService
 * - DashboardController / DashboardService
 * - SecurityController / SecurityService
 * - StatementController / StatementService
 * - AuditRetentionProcessor (BullMQ weekly job)
 */
import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { MulterModule } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';

import { PrismaModule } from '../../prisma/prisma.module';
import { AuditModule } from '../audit/audit.module';
import { CommonServicesModule } from '../../common/services/common-services.module';

import { FinancialImportController } from './financial-import.controller';
import { FinancialImportService } from './financial-import.service';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';
import { SecurityController } from './security.controller';
import { SecurityService } from './security.service';
import { StatementController } from './statement.controller';
import { StatementService } from './statement.service';
import { AuditRetentionProcessor } from './processors/audit-retention.processor';

export const AUDIT_RETENTION_QUEUE = 'audit.retention';

@Module({
  imports: [
    PrismaModule,
    AuditModule,
    CommonServicesModule,
    BullModule.registerQueue({ name: AUDIT_RETENTION_QUEUE }),
    MulterModule.register({ storage: memoryStorage() }),
  ],
  controllers: [
    FinancialImportController,
    DashboardController,
    SecurityController,
    StatementController,
  ],
  providers: [
    FinancialImportService,
    DashboardService,
    SecurityService,
    StatementService,
    AuditRetentionProcessor,
  ],
  exports: [
    FinancialImportService,
    DashboardService,
    SecurityService,
    StatementService,
  ],
})
export class Sprint3Module {}
