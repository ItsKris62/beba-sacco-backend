import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { MembersController } from './members.controller';
import { MembersService } from './members.service';
import { MemberPortalController } from './member-portal.controller';
import { MemberPortalService } from './member-portal.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditModule } from '../audit/audit.module';
import { MpesaModule } from '../mpesa/mpesa.module';
import { LoansModule } from '../loans/loans.module';
import { LoanApplicationModule } from '../loans/loan-application.module';
import { StatementsModule } from '../statements/statements.module';
import { StorageModule } from '../storage/storage.module';
import { QUEUE_NAMES } from '../queue/queue.constants';

@Module({
  imports: [
    AuditModule,
    MpesaModule,
    LoansModule,
    LoanApplicationModule, // ✅ Makes LoanApplicationService available to MemberPortalController
    StatementsModule,
    StorageModule,
    BullModule.registerQueue({ name: QUEUE_NAMES.EMAIL }),
  ],
  controllers: [MembersController, MemberPortalController],
  providers: [MembersService, MemberPortalService, PrismaService],
  exports: [MembersService, MemberPortalService],
})
export class MembersModule {}
