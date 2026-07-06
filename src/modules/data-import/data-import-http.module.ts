import { Module } from '@nestjs/common';
import { MulterModule } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { DataImportModule } from './data-import.module';
import { DataImportController } from './data-import.controller';
import { FinancialImportController } from './financial-import.controller';

@Module({
  imports: [
    DataImportModule,
    MulterModule.register({ storage: memoryStorage() }),
  ],
  controllers: [DataImportController, FinancialImportController],
})
export class DataImportHttpModule {}