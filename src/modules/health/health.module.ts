import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { HealthController } from './health.controller';
import { PrismaService } from '../../prisma/prisma.service';
import { StorageModule } from '../storage/storage.module';
// RedisService is @Global via CommonServicesModule — no explicit import needed

@Module({
  imports: [TerminusModule, StorageModule],
  controllers: [HealthController],
  providers: [PrismaService],
})
export class HealthModule {}
