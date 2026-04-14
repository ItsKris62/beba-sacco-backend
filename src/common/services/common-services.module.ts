import { Global, Module } from '@nestjs/common';
import { RedisService } from './redis.service';
import { IdempotencyService } from './idempotency.service';
import { PlunkService } from './plunk.service';

/**
 * @Global() — makes RedisService, IdempotencyService, and PlunkService available
 * everywhere without importing CommonServicesModule in each feature module.
 */
@Global()
@Module({
  providers: [RedisService, IdempotencyService, PlunkService],
  exports: [RedisService, IdempotencyService, PlunkService],
})
export class CommonServicesModule {}
