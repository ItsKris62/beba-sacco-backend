import { SetMetadata } from '@nestjs/common';

export const RATE_LIMIT_ENDPOINT_KEY = 'rate_limit_endpoint';

/**
 * Maps a controller route to a specific rate limit configuration key defined in the RATE_LIMITS env var.
 * Example: @RateLimitEndpoint('loan_apply') matches {"member": {"loan_apply": "5/minute"}}
 * 
 * @param endpoint The string key representing the logical operation
 */
export const RateLimitEndpoint = (endpoint: string) => SetMetadata(RATE_LIMIT_ENDPOINT_KEY, endpoint);