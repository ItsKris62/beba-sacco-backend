import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { SupportModule } from './support.module';
import { SupportController } from './support.controller';
import { IncidentsController } from './incidents.controller';
import { TicketAttachmentsController } from './ticket-attachments.controller';

@Module({
  imports: [SupportModule, AuthModule],
  controllers: [SupportController, IncidentsController, TicketAttachmentsController],
})
export class SupportHttpModule {}