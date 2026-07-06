import { Module } from '@nestjs/common';
import { ReportsModule } from './reports.module';
import { ReportsController } from './reports.controller';

@Module({
  imports: [ReportsModule],
  controllers: [ReportsController],
})
export class ReportsHttpModule {}