import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditModule } from '../audit/audit.module';
import { QUEUE_NAMES } from '../queue/queue.constants';

@Module({
  imports: [
    AuditModule,
    BullModule.registerQueue({ name: QUEUE_NAMES.EMAIL }),
  ],
  controllers: [AdminController],
  providers: [AdminService, PrismaService],
  exports: [AdminService],
})
export class AdminModule {}
