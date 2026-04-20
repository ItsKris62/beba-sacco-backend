import { Module } from '@nestjs/common';
import { StagesController } from './stages.controller';
import { StagesService } from './stages.service';
import { PrismaModule } from '../../prisma/prisma.module';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [PrismaModule, AuditModule],
  controllers: [StagesController],
  providers: [StagesService],
  exports: [StagesService],
})
export class StagesModule {}
