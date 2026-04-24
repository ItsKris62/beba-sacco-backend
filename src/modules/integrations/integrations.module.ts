import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { BullModule } from '@nestjs/bullmq';
import { QUEUE_NAMES } from '../queue/queue.constants';

// Services
import { OutboxService } from './outbox/outbox.service';
import { CrbService } from './crb/crb.service';
import { AmlService } from './aml/aml.service';
import { Ifrs9EclService } from './ifrs9/ifrs9-ecl.service';
import { SasraRatiosService } from './sasra/sasra-ratios.service';
import { DsarService } from './dsar/dsar.service';
import { CbkReturnService } from './cbk/cbk-return.service';
import { NotificationsService } from './notifications/notifications.service';
import { ApiGatewayService } from './gateway/api-gateway.service';

// Controllers
import {
  CrbController,
  AmlController,
  CompliancePhase5Controller,
  ApiGatewayController,
  MonitoringController,
} from './integrations.controller';

// Dependencies
import { WebhooksModule } from '../webhooks/webhooks.module';
import { CommonServicesModule } from '../../common/services/common-services.module';

/**
 * IntegrationsModule – Phase 5
 *
 * Provides:
 *   - CRB Reporting (outbox-guaranteed XML export)
 *   - AML/CFT Screening (async sanctions/PEP screening)
 *   - IFRS 9 ECL Calculator (daily PD×LGD×EAD provisioning)
 *   - SASRA Liquidity & Capital Ratios
 *   - DSAR Automation (Kenya DPA compliance)
 *   - CBK Monthly Return Generator
 *   - Multi-Channel Notifications (SMS/WhatsApp/Email)
 *   - Open API Gateway (OAuth2 client_credentials)
 *   - Integration Outbox (at-least-once delivery guarantee)
 */
@Module({
  imports: [
    ScheduleModule.forRoot(),
    BullModule.registerQueue(
      { name: QUEUE_NAMES.CRB_EXPORT },
      { name: QUEUE_NAMES.AML_SCREEN },
      { name: QUEUE_NAMES.NOTIFY_MULTI },
      { name: QUEUE_NAMES.OUTBOX_PUBLISH },
      { name: QUEUE_NAMES.IFRS9_ECL },
      { name: QUEUE_NAMES.DSAR_PROCESS },
    ),
    WebhooksModule,
    CommonServicesModule,
  ],
  providers: [
    OutboxService,
    CrbService,
    AmlService,
    Ifrs9EclService,
    SasraRatiosService,
    DsarService,
    CbkReturnService,
    NotificationsService,
    ApiGatewayService,
  ],
  controllers: [
    CrbController,
    AmlController,
    CompliancePhase5Controller,
    ApiGatewayController,
    MonitoringController,
  ],
  exports: [
    OutboxService,
    CrbService,
    AmlService,
    Ifrs9EclService,
    SasraRatiosService,
    DsarService,
    CbkReturnService,
    NotificationsService,
    ApiGatewayService,
  ],
})
export class IntegrationsModule {}
