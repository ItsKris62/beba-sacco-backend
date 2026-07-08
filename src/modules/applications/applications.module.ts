import { Module } from '@nestjs/common';
import { ApplicationsController } from './applications.controller';
import { ApplicationsService } from './applications.service';
import { OnboardingService } from './onboarding.service';
import { PrismaModule } from '../../prisma/prisma.module';
import { AuditModule } from '../audit/audit.module';
import { SmsModule } from '../sms/sms.module';

@Module({
  imports: [PrismaModule, AuditModule, SmsModule],
  controllers: [ApplicationsController],
  providers: [ApplicationsService, OnboardingService],
  exports: [ApplicationsService, OnboardingService],
})
export class ApplicationsModule {}
