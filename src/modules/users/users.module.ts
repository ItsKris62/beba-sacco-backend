import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditModule } from '../audit/audit.module';
import { QUEUE_NAMES } from '../queue/queue.constants';

@Module({
  imports: [
    AuditModule,
    BullModule.registerQueue({ name: QUEUE_NAMES.EMAIL }),
  ],
  controllers: [UsersController],
  providers: [UsersService, PrismaService],
  exports: [UsersService],
})
export class UsersModule {}
