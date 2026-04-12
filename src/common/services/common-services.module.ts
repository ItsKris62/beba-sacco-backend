import { Global, Module } from '@nestjs/common';
import { RedisService } from './redis.service';
import { IdempotencyService } from './idempotency.service';

/**
 * @Global() — makes RedisService and IdempotencyService available everywhere
 * without importing CommonServicesModule in each feature module.
 */
@Global()
@Module({
  providers: [RedisService, IdempotencyService],
  exports: [RedisService, IdempotencyService],
})
export class CommonServicesModule {}
