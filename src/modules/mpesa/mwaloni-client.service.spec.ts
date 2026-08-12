import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import { RedisService } from '../../common/services/redis.service';
import { MwaloniClientService } from './mwaloni-client.service';

type ConfigMap = Record<string, unknown>;

const baseConfig: ConfigMap = {
  'app.mwaloni.enabled': true,
  'app.mwaloni.env': 'production',
  'app.mwaloni.urlProduction': 'https://wallet.mwaloni.com/api/',
  'app.mwaloni.urlSandbox': 'https://wallet-stg.mwaloni.com/api/',
  'app.mwaloni.serviceId': ' SRV-00001 ',
  'app.mwaloni.username': ' runtime-user ',
  'app.mwaloni.password': ' runtime-password ',
  'app.mwaloni.apiKey': ' runtime-api-key ',
};

function makeConfig(overrides: ConfigMap = {}): ConfigService {
  const map = { ...baseConfig, ...overrides };
  return {
    get: jest.fn((key: string, def?: unknown) => map[key] ?? def),
  } as unknown as ConfigService;
}

function makeRedis(): RedisService {
  return {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue(true),
    del: jest.fn().mockResolvedValue(1),
  } as unknown as RedisService;
}

function mockJsonResponse(status: number, body: Record<string, unknown>): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: jest.fn().mockResolvedValue(body),
    text: jest.fn().mockResolvedValue(JSON.stringify(body)),
  } as unknown as Response;
}

describe('MwaloniClientService.diagnoseAuthentication', () => {
  let fetchMock: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    fetchMock = jest.spyOn(global, 'fetch');
  });

  afterEach(() => {
    fetchMock.mockRestore();
  });

  it('returns deterministic runtime fingerprints without leaking credentials', async () => {
    fetchMock.mockResolvedValueOnce(
      mockJsonResponse(200, { status: '01', message: 'Invalid credentials' }),
    );
    const service = new MwaloniClientService(makeConfig(), makeRedis());

    const result = await service.diagnoseAuthentication();

    expect(result.fields.username.sha256).toBe(
      createHash('sha256').update('runtime-user', 'utf8').digest('hex'),
    );
    expect(result.fields.apiKey.sha256).toBe(
      createHash('sha256').update('runtime-api-key', 'utf8').digest('hex'),
    );
    expect(result.fields.password.sha256).toBeUndefined();
    expect(result.fields.username).toMatchObject({
      present: true,
      length: 14,
      trimmedLength: 12,
      hasLeadingWhitespace: true,
      hasTrailingWhitespace: true,
    });
    expect(result.fields.apiKey).toMatchObject({
      present: true,
      length: 17,
      trimmedLength: 15,
      hasLeadingWhitespace: true,
      hasTrailingWhitespace: true,
    });

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('runtime-user');
    expect(serialized).not.toContain('runtime-password');
    expect(serialized).not.toContain('runtime-api-key');
  });

  it('does not attempt provider auth when required configuration is missing', async () => {
    const service = new MwaloniClientService(
      makeConfig({ 'app.mwaloni.password': '   ' }),
      makeRedis(),
    );

    const result = await service.diagnoseAuthentication();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.authResult).toMatchObject({
      attempted: false,
      success: false,
      status: 'CONFIG_MISSING',
      errorCode: 'MWALONI_CONFIG_MISSING',
      retryable: false,
    });
    expect(result.authResult.message).toContain('MWALONI_PASSWORD');
  });

  it('sanitizes a status=01 provider authentication failure and does not fetch balance', async () => {
    fetchMock.mockResolvedValueOnce(
      mockJsonResponse(200, { status: '01', message: 'Invalid credentials' }),
    );
    const service = new MwaloniClientService(makeConfig(), makeRedis());

    const result = await service.diagnoseAuthentication();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://wallet.mwaloni.com/api/authenticate');
    expect(url).not.toContain('get-balance');
    expect(init.headers).toEqual({
      'Content-Type': 'application/json',
      'x-api-key': 'runtime-api-key',
    });
    expect(JSON.parse(String(init.body))).toEqual({
      username: 'runtime-user',
      password: 'runtime-password',
    });
    expect(result.authResult).toMatchObject({
      attempted: true,
      success: false,
      status: '01',
      message: 'Invalid credentials',
      tokenReturned: false,
      httpStatus: 200,
      errorCode: 'MWALONI_AUTH_FAILED',
      retryable: false,
    });
  });

  it('redacts runtime credential values if a provider error message echoes them', async () => {
    fetchMock.mockResolvedValueOnce(
      mockJsonResponse(200, {
        status: '01',
        message: 'Rejected runtime-user runtime-password runtime-api-key',
      }),
    );
    const service = new MwaloniClientService(makeConfig(), makeRedis());

    const result = await service.diagnoseAuthentication();

    expect(result.authResult.message).toBe('Rejected [REDACTED] [REDACTED] [REDACTED]');
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('runtime-user');
    expect(serialized).not.toContain('runtime-password');
    expect(serialized).not.toContain('runtime-api-key');
  });

  it('reports successful authentication without returning the bearer token', async () => {
    fetchMock.mockResolvedValueOnce(
      mockJsonResponse(200, {
        status: '00',
        message: 'Success',
        data: {
          token: 'secret-provider-token',
          tokenType: 'Bearer',
          expiresIn: 3600,
        },
      }),
    );
    const service = new MwaloniClientService(makeConfig(), makeRedis());

    const result = await service.diagnoseAuthentication();

    expect(result.authResult).toEqual({
      attempted: true,
      success: true,
      status: '00',
      message: 'Success',
      tokenReturned: true,
      tokenType: 'Bearer',
      expiresIn: 3600,
      httpStatus: 200,
      errorCode: null,
      retryable: false,
    });
    expect(JSON.stringify(result)).not.toContain('secret-provider-token');
  });

  it('does not automatically retry the money-moving send-money POST after an ambiguous provider failure', async () => {
    fetchMock
      .mockResolvedValueOnce(
        mockJsonResponse(200, {
          status: '00',
          message: 'Success',
          data: { token: 'provider-token', expiresIn: 3600 },
        }),
      )
      .mockResolvedValueOnce(mockJsonResponse(500, { status: '99', message: 'Provider down' }));

    const service = new MwaloniClientService(makeConfig(), makeRedis());

    await expect(
      service.sendMobile({
        orderNumber: 'MWD-ledger-tx-1',
        phoneNumber: '254712345678',
        amount: 500,
        description: 'FOSA withdrawal FOSA-001',
      }),
    ).rejects.toThrow('Mwaloni send money HTTP 500');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toBe('https://wallet.mwaloni.com/api/send-money');
  });
});
