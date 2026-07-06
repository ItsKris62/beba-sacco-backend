import { Module } from '@nestjs/common';
import { AccountingModule } from './accounting.module';
import { AccountingController } from './accounting.controller';

@Module({
  imports: [AccountingModule],
  controllers: [AccountingController],
})
export class AccountingHttpModule {}