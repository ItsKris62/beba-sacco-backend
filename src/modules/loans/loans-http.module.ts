import { Module } from '@nestjs/common';
import { LoansModule } from './loans.module';
import { LoansController } from './loans.controller';

@Module({
  imports: [LoansModule],
  controllers: [LoansController],
})
export class LoansHttpModule {}