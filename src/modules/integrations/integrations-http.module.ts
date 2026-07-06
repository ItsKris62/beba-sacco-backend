import { Module } from '@nestjs/common';
import { IntegrationsModule } from './integrations.module';
import {
  CrbController,
  AmlController,
  CompliancePhase5Controller,
  ApiGatewayController,
  MonitoringController,
} from './integrations.controller';

@Module({
  imports: [IntegrationsModule],
  controllers: [
    CrbController,
    AmlController,
    CompliancePhase5Controller,
    ApiGatewayController,
    MonitoringController,
  ],
})
export class IntegrationsHttpModule {}