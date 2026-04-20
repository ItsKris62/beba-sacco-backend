import { Module } from '@nestjs/common';
import { LocationsController } from './locations.controller';
import { LocationsService } from './locations.service';
import { PrismaModule } from '../../prisma/prisma.module';
import { CommonServicesModule } from '../../common/services/common-services.module';

@Module({
  imports: [PrismaModule, CommonServicesModule],
  controllers: [LocationsController],
  providers: [LocationsService],
  exports: [LocationsService],
})
export class LocationsModule {}
