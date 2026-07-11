import { Module } from '@nestjs/common';
import { MpesaModule } from './mpesa.module';
import { MpesaController } from './mpesa.controller';
import { MpesaWebhookController } from './mpesa-webhook.controller';
import { AdminReconciliationController } from './admin-reconciliation.controller';
import { MpesaIpGuard } from './guards/mpesa-ip.guard';

@Module({
  imports: [MpesaModule],
  controllers: [MpesaController, MpesaWebhookController, AdminReconciliationController],
  providers: [MpesaIpGuard],
})
export class MpesaHttpModule {}