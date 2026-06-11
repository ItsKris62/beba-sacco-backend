import { Test, TestingModule } from '@nestjs/testing';
import { createHash } from 'crypto';
import { OtpService } from '../otp.service';
import { RedisService } from '../../../common/services/redis.service';

const TEST_PHONE = '+254712345678';
const OTP_TTL_SECONDS = 1800;

interface StoredOtpRecord {
  code: string;
  attempts: number;
}

interface MockRedisService {
  getJson: jest.Mock<Promise<StoredOtpRecord | null>, [string]>;
  setJson: jest.Mock<Promise<boolean>, [string, StoredOtpRecord, number]>;
  del: jest.Mock<Promise<void>, [string]>;
}

const buildOtpKey = (phone: string): string =>
  `otp:pwd-reset:${createHash('sha256').update(phone).digest('hex')}`;

describe('OtpService', () => {
  let service: OtpService;
  let redis: MockRedisService;

  beforeEach(async () => {
    redis = {
      getJson: jest.fn(),
      setJson: jest.fn().mockResolvedValue(true),
      del: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [OtpService, { provide: RedisService, useValue: redis }],
    }).compile();

    service = module.get<OtpService>(OtpService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('generates a 6-digit OTP and stores it with the SHA-256 phone key and 30-minute TTL', async () => {
    const code = await service.generate(TEST_PHONE);
    const expectedKey = buildOtpKey(TEST_PHONE);

    expect(code).toMatch(/^\d{6}$/);
    expect(redis.setJson).toHaveBeenCalledWith(
      expectedKey,
      { code, attempts: 0 },
      OTP_TTL_SECONDS,
    );
  });

  it('validates a correct OTP and deletes the Redis key', async () => {
    const expectedKey = buildOtpKey(TEST_PHONE);
    redis.getJson.mockResolvedValue({ code: '123456', attempts: 0 });

    const result = await service.validate(TEST_PHONE, '123456');

    expect(result).toBe(true);
    expect(redis.getJson).toHaveBeenCalledWith(expectedKey);
    expect(redis.del).toHaveBeenCalledWith(expectedKey);
    expect(redis.setJson).not.toHaveBeenCalled();
  });

  it('returns false for a wrong OTP, increments attempts, and preserves the TTL', async () => {
    const expectedKey = buildOtpKey(TEST_PHONE);
    redis.getJson.mockResolvedValue({ code: '123456', attempts: 0 });

    const result = await service.validate(TEST_PHONE, '999999');

    expect(result).toBe(false);
    expect(redis.setJson).toHaveBeenCalledWith(
      expectedKey,
      { code: '123456', attempts: 1 },
      OTP_TTL_SECONDS,
    );
    expect(redis.del).not.toHaveBeenCalled();
  });

  it('returns false and deletes the key after the third failed attempt', async () => {
    const expectedKey = buildOtpKey(TEST_PHONE);
    redis.getJson.mockResolvedValue({ code: '123456', attempts: 2 });

    const result = await service.validate(TEST_PHONE, '999999');

    expect(result).toBe(false);
    expect(redis.del).toHaveBeenCalledWith(expectedKey);
    expect(redis.setJson).not.toHaveBeenCalled();
  });

  it('returns false when the OTP key is missing or expired', async () => {
    redis.getJson.mockResolvedValue(null);

    const result = await service.validate(TEST_PHONE, '123456');

    expect(result).toBe(false);
    expect(redis.del).not.toHaveBeenCalled();
    expect(redis.setJson).not.toHaveBeenCalled();
  });

  it('uses a SHA-256 hash instead of the raw phone number in the Redis key', async () => {
    await service.generate(TEST_PHONE);

    const [key] = redis.setJson.mock.calls[0];
    const hash = key.replace('otp:pwd-reset:', '');

    expect(key).toBe(buildOtpKey(TEST_PHONE));
    expect(key).not.toContain(TEST_PHONE);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });
});
