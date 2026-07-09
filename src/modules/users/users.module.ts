import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditModule } from '../audit/audit.module';
import { PinModule } from '../pin/pin.module';
import { SmsModule } from '../sms/sms.module';
import { QUEUE_NAMES } from '../queue/queue.constants';
import { EncryptionService } from '../zero-trust/encryption/encryption.service';

@Module({
  imports: [
    AuditModule,
    PinModule,
    SmsModule,
    BullModule.registerQueue({ name: QUEUE_NAMES.EMAIL }),
  ],
  controllers: [UsersController],
  providers: [UsersService, PrismaService, EncryptionService],
  exports: [UsersService],
})
export class UsersModule {}
