import { Module } from '@nestjs/common';
import { Phase6Module } from './phase6.module';
import { Phase6AdminController } from './phase6-admin.controller';

@Module({
  imports: [Phase6Module],
  controllers: [Phase6AdminController],
})
export class Phase6HttpModule {}