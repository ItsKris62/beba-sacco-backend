import { Module } from '@nestjs/common';
import { ApplicationsController } from './applications.controller';
import { ApplicationsService } from './applications.service';
import { OnboardingService } from './onboarding.service';
import { PrismaModule } from '../../prisma/prisma.module';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [PrismaModule, AuditModule],
  controllers: [ApplicationsController],
  providers: [ApplicationsService, OnboardingService],
  exports: [ApplicationsService, OnboardingService],
})
export class ApplicationsModule {}
