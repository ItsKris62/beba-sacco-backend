import { Module } from '@nestjs/common';
import { DocumentsModule } from './documents.module';
import { AdminDocumentsController } from './admin-documents.controller';

@Module({
  imports: [DocumentsModule],
  controllers: [AdminDocumentsController],
})
export class DocumentsHttpModule {}