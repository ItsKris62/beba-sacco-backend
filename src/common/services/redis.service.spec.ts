import { ConfigService } from '@nestjs/config';
import { RedisService } from './redis.service';

// ─── ioredis mock ─────────────────────────────────────────────────────────────
// We mock the ioredis module so no real TCP connection is made.

const mockPipeline = {
  incr: jest.fn().mockReturnThis(),
  pexpireat: jest.fn().mockReturnThis(),
  exec: jest.fn(),
};

const mockRedisClient = {
  on: jest.fn(),
  connect: jest.fn().mockResolvedValue(undefined),
  disconnect: jest.fn(),
  get: jest.fn(),
  set: jest.fn(),
  setex: jest.fn(),
  del: jest.fn(),
  exists: jest.fn(),
  incr: jest.fn(),
  incrby: jest.fn(),
  expire: jest.fn(),
  pexpireat: jest.fn(),
  ttl: jest.fn(),
  scan: jest.fn(),
  publish: jest.fn(),
  duplicate: jest.fn(),
  ping: jest.fn(),
  pipeline: jest.fn(() => mockPipeline),
};

jest.mock('ioredis', () => {
  return jest.fn().mockImplementation(() => mockRedisClient);
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeConfig(): ConfigService {
  return {
    get: jest.fn((key: string, def?: unknown) => {
      const map: Record<string, unknown> = {
        'app.redis.host': 'localhost',
        'app.redis.port': 6379,
        'app.redis.password': 'test-pass',
        'app.redis.tls': false,
      };
      return map[key] ?? def;
    }),
  } as unknown as ConfigService;
}

// ─── Suite ───────────────────────────────────────────────────────────────────

describe('RedisService.incrWithExpireAt [M-1]', () => {
  let service: RedisService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new RedisService(makeConfig());
  });

  it('returns the incremented counter value from the pipeline result', async () => {
    mockPipeline.exec.mockResolvedValue([
      [null, 3],   // [error, incrValue]
      [null, 1],   // [error, pexpireat result]
    ]);

    const result = await service.incrWithExpireAt('test-key', Date.now() + 60_000);
    expect(result).toBe(3);
  });

  it('calls INCR and PEXPIREAT in a single pipeline (one round-trip)', async () => {
    mockPipeline.exec.mockResolvedValue([[null, 1], [null, 1]]);
    const expireAt = Date.now() + 86_400_000;

    await service.incrWithExpireAt('rl-key', expireAt);

    expect(mockRedisClient.pipeline).toHaveBeenCalledTimes(1);
    expect(mockPipeline.incr).toHaveBeenCalledWith('rl-key');
    expect(mockPipeline.pexpireat).toHaveBeenCalledWith('rl-key', expireAt);
    expect(mockPipeline.exec).toHaveBeenCalledTimes(1);
  });

  it('[M-1] does NOT use separate incr() + expire() calls', async () => {
    mockPipeline.exec.mockResolvedValue([[null, 1], [null, 1]]);

    await service.incrWithExpireAt('rl-key', Date.now() + 60_000);

    // The standalone client.incr and client.expire must not be called
    expect(mockRedisClient.incr).not.toHaveBeenCalled();
    expect(mockRedisClient.expire).not.toHaveBeenCalled();
  });

  it('returns 0 and does not throw when the pipeline errors (fail-open)', async () => {
    mockPipeline.exec.mockRejectedValue(new Error('Redis connection lost'));

    const result = await service.incrWithExpireAt('rl-key', Date.now() + 60_000);
    expect(result).toBe(0);
  });

  it('returns 0 when the pipeline result is null', async () => {
    mockPipeline.exec.mockResolvedValue(null);

    const result = await service.incrWithExpireAt('rl-key', Date.now() + 60_000);
    expect(result).toBe(0);
  });

  it('returns 0 when the INCR result has an error', async () => {
    mockPipeline.exec.mockResolvedValue([
      [new Error('WRONGTYPE'), null],
      [null, 1],
    ]);

    const result = await service.incrWithExpireAt('rl-key', Date.now() + 60_000);
    expect(result).toBe(0);
  });
});

describe('RedisService.incr [regression: existing behaviour preserved]', () => {
  let service: RedisService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new RedisService(makeConfig());
  });

  it('returns the incremented value', async () => {
    mockRedisClient.incr.mockResolvedValue(5);
    const result = await service.incr('some-key');
    expect(result).toBe(5);
  });

  it('calls expire when ttlSeconds is supplied and value is 1', async () => {
    mockRedisClient.incr.mockResolvedValue(1);
    mockRedisClient.expire.mockResolvedValue(1);
    await service.incr('some-key', 300);
    expect(mockRedisClient.expire).toHaveBeenCalledWith('some-key', 300);
  });

  it('does not call expire when value > 1', async () => {
    mockRedisClient.incr.mockResolvedValue(2);
    await service.incr('some-key', 300);
    expect(mockRedisClient.expire).not.toHaveBeenCalled();
  });
});
