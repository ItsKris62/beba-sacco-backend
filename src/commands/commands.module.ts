import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { RemediateStrandedDataCommand } from './remediate-stranded-data.command';

@Module({
  imports: [PrismaModule],
  providers: [RemediateStrandedDataCommand],
  exports: [RemediateStrandedDataCommand],
})
export class CommandsModule {}
