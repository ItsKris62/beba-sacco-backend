import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ApplicationsController } from './applications.controller';
import { ApplicationsService } from './applications.service';
import { OnboardingService } from './onboarding.service';
import { PrismaModule } from '../../prisma/prisma.module';
import { AuditModule } from '../audit/audit.module';
import { SmsModule } from '../sms/sms.module';
import { QUEUE_NAMES } from '../queue/queue.constants';

@Module({
  imports: [
    PrismaModule,
    AuditModule,
    SmsModule,
    BullModule.registerQueue({ name: QUEUE_NAMES.DOCUMENT_INGESTION }),
  ],
  controllers: [ApplicationsController],
  providers: [ApplicationsService, OnboardingService],
  exports: [ApplicationsService, OnboardingService],
})
export class ApplicationsModule {}
