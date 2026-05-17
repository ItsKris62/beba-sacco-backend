import { Module } from '@nestjs/common';
import { MetricsApiKeyGuard } from '../../common/guards/metrics-api-key.guard';
import { MetricsController } from './metrics.controller';
import { MetricsService } from './metrics.service';

@Module({
  controllers: [MetricsController],
  providers: [MetricsService, MetricsApiKeyGuard],
  exports: [MetricsService],
})
export class MetricsModule {}
