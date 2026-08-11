import * as crypto from 'crypto';
import { ConfigService } from '@nestjs/config';
import { UserRole } from '@prisma/client';
import { MpesaController } from './mpesa.controller';
import { MpesaService } from './mpesa.service';
import { MpesaTenantResolverService } from './mpesa-tenant-resolver.service';
import { ROLES_KEY } from '../../common/decorators/roles.decorator';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const SECRET = 'test-webhook-secret-32-chars-long!!';

function hmac(body: Buffer, secret: string): string {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

function makeConfig(secret: string | undefined): ConfigService {
  return {
    get: jest.fn((key: string) => {
      if (key === 'app.mpesa.webhookSecret') return secret;
      return undefined;
    }),
  } as unknown as ConfigService;
}

const mockMpesaService = {
  enqueueCallback: jest.fn().mockResolvedValue(undefined),
  queueLoanDisbursement: jest.fn(),
  requeueFromDlq: jest.fn(),
  initiateDeposit: jest.fn(),
  getB2cWalletBalance: jest.fn(),
  diagnoseMwaloniB2cAuthentication: jest.fn(),
} as unknown as MpesaService;

const mockTenantResolver = {
  validateCallback: jest.fn().mockResolvedValue(true),
  resolveTenant: jest.fn(),
} as unknown as MpesaTenantResolverService;

function flushCallbacks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

// STK Push payload fixture
const STK_BODY = {
  Body: {
    stkCallback: {
      MerchantRequestID: 'mr-1',
      CheckoutRequestID: 'ws_CO_1',
      ResultCode: 0,
      ResultDesc: 'Success',
    },
  },
};

// C2B payload fixture
const C2B_BODY = {
  TransactionType: 'Pay Bill',
  TransID: 'TXN123456',
  TransTime: '20240101120000',
  TransAmount: '500.00',
  BusinessShortCode: '174379',
  BillRefNumber: 'ACC-001',
  MSISDN: '254712345678',
};

// B2C payload fixture
const B2C_BODY = {
  Result: {
    ConversationID: 'conv-abc',
    OriginatorConversationID: 'orig-abc',
    ResultCode: 0,
    ResultDesc: 'Success',
    TransactionID: 'TXN_B2C',
    ResultParameters: { ResultParameter: [] },
  },
};

// ─── Suite ───────────────────────────────────────────────────────────────────

describe('MpesaController – unified callback HMAC [C-3]', () => {
  let controller: MpesaController;

  beforeEach(() => {
    jest.clearAllMocks();
    (mockTenantResolver.validateCallback as jest.Mock).mockImplementation(
      ({ rawBody, signature }: { rawBody?: Buffer; signature?: string }) =>
        Boolean(rawBody && signature && hmac(rawBody, SECRET) === signature),
    );
    (mockTenantResolver.resolveTenant as jest.Mock).mockImplementation(
      (body: Record<string, unknown>) => {
        if ('TransactionType' in body)
          return { tenantId: 'tenant-1', callbackType: 'C2B', uniqueId: 'TXN123456' };
        const result = (body as typeof B2C_BODY).Result;
        if (result) {
          return {
            tenantId: 'tenant-1',
            callbackType: result.ResultCode === 17 ? 'B2C_TIMEOUT' : 'B2C_RESULT',
            uniqueId: 'conv-abc',
          };
        }
        return { tenantId: 'tenant-1', callbackType: 'STK_PUSH', uniqueId: 'ws_CO_1' };
      },
    );
    controller = new MpesaController(mockMpesaService, makeConfig(SECRET), mockTenantResolver);
  });

  // ── Signature bypass in dev/sandbox ────────────────────────────────────

  it('accepts callback without a signature when no webhook secret is configured', async () => {
    const noSecretController = new MpesaController(
      mockMpesaService,
      makeConfig(undefined),
      mockTenantResolver,
    );
    (mockTenantResolver.validateCallback as jest.Mock).mockResolvedValueOnce(true);
    const rawBody = Buffer.from(JSON.stringify(STK_BODY));
    const result = await noSecretController.unifiedCallback(
      { rawBody } as never,
      STK_BODY as never,
      undefined,
    );
    await flushCallbacks();
    expect(result).toEqual({ ResultCode: 0, ResultDesc: 'Accepted' });
    expect(mockMpesaService.enqueueCallback).toHaveBeenCalledWith(
      expect.objectContaining(STK_BODY),
      'STK_PUSH',
      'ws_CO_1',
      'tenant-1',
      expect.any(String),
    );
  });

  // ── Signature validation ────────────────────────────────────────────────

  it('[C-3] accepts a callback with a valid HMAC-SHA256 signature', async () => {
    const rawBody = Buffer.from(JSON.stringify(STK_BODY));
    const sig = hmac(rawBody, SECRET);

    const result = await controller.unifiedCallback({ rawBody } as never, STK_BODY as never, sig);
    await flushCallbacks();
    expect(result).toEqual({ ResultCode: 0, ResultDesc: 'Accepted' });
    expect(mockMpesaService.enqueueCallback).toHaveBeenCalledTimes(1);
  });

  it('[C-3] rejects a callback with a missing signature without enqueueing', async () => {
    const rawBody = Buffer.from(JSON.stringify(STK_BODY));

    await expect(
      controller.unifiedCallback(
        { rawBody } as never,
        STK_BODY as never,
        undefined, // no signature
      ),
    ).rejects.toThrow('M-Pesa callback validation failed');
    expect(mockMpesaService.enqueueCallback).not.toHaveBeenCalled();
  });

  it('[C-3] rejects a callback with a tampered signature without enqueueing', async () => {
    const rawBody = Buffer.from(JSON.stringify(STK_BODY));
    const wrongSig = hmac(rawBody, 'different-secret');

    await expect(
      controller.unifiedCallback({ rawBody } as never, STK_BODY as never, wrongSig),
    ).rejects.toThrow('M-Pesa callback validation failed');
    expect(mockMpesaService.enqueueCallback).not.toHaveBeenCalled();
  });

  it('[C-3] rejects a callback with a non-hex signature string without enqueueing', async () => {
    const rawBody = Buffer.from(JSON.stringify(STK_BODY));

    await expect(
      controller.unifiedCallback({ rawBody } as never, STK_BODY as never, 'not-a-hex-string!!'),
    ).rejects.toThrow('M-Pesa callback validation failed');
    expect(mockMpesaService.enqueueCallback).not.toHaveBeenCalled();
  });

  // ── Payload routing ────────────────────────────────────────────────────

  it('routes a valid C2B callback to enqueueCallback with type C2B', async () => {
    const rawBody = Buffer.from(JSON.stringify(C2B_BODY));
    const sig = hmac(rawBody, SECRET);

    await controller.unifiedCallback({ rawBody } as never, C2B_BODY as never, sig);
    await flushCallbacks();

    expect(mockMpesaService.enqueueCallback).toHaveBeenCalledWith(
      expect.objectContaining(C2B_BODY),
      'C2B',
      'TXN123456',
      'tenant-1',
      expect.any(String),
    );
  });

  it('routes a valid B2C result callback to enqueueCallback with type B2C_RESULT', async () => {
    const rawBody = Buffer.from(JSON.stringify(B2C_BODY));
    const sig = hmac(rawBody, SECRET);

    await controller.unifiedCallback({ rawBody } as never, B2C_BODY as never, sig);
    await flushCallbacks();

    expect(mockMpesaService.enqueueCallback).toHaveBeenCalledWith(
      expect.objectContaining(B2C_BODY),
      'B2C_RESULT',
      'conv-abc',
      'tenant-1',
      expect.any(String),
    );
  });

  it('classifies a B2C result with ResultCode 17 as B2C_TIMEOUT', async () => {
    const timeoutBody = {
      Result: { ...B2C_BODY.Result, ResultCode: 17, ResultDesc: 'request cancelled' },
    };
    const rawBody = Buffer.from(JSON.stringify(timeoutBody));
    const sig = hmac(rawBody, SECRET);

    await controller.unifiedCallback({ rawBody } as never, timeoutBody as never, sig);
    await flushCallbacks();

    expect(mockMpesaService.enqueueCallback).toHaveBeenCalledWith(
      expect.objectContaining(timeoutBody),
      'B2C_TIMEOUT',
      'conv-abc',
      'tenant-1',
      expect.any(String),
    );
  });

  it('fetches global B2C wallet balance through the super-admin endpoint', async () => {
    const snapshot = {
      provider: 'MWALONI',
      currency: 'KES',
      balance: 125000,
      availableBalance: 125000,
      actualBalance: 125000,
      providerStatus: '00',
      message: 'Success',
      checkedAt: '2026-08-11T14:30:00.000Z',
      providerData: { status: '00' },
    };
    (mockMpesaService.getB2cWalletBalance as jest.Mock).mockResolvedValueOnce(snapshot);

    await expect(
      controller.getB2cWalletBalance(
        { id: 'tenant-1' } as never,
        { id: 'super-1', role: UserRole.SUPER_ADMIN } as never,
      ),
    ).resolves.toEqual(snapshot);
    expect(mockMpesaService.getB2cWalletBalance).toHaveBeenCalledWith('super-1', 'tenant-1');
  });

  it('marks the global B2C wallet balance endpoint as SUPER_ADMIN only', () => {
    expect(Reflect.getMetadata(ROLES_KEY, controller.getB2cWalletBalance)).toEqual([
      UserRole.SUPER_ADMIN,
    ]);
  });

  it('runs the Mwaloni auth diagnostic through the super-admin endpoint', async () => {
    const diagnostic = {
      tenantId: 'tenant-1',
      connectionId: null,
      credentialSource: 'ENVIRONMENT_VARIABLES',
      effectiveEnvironment: 'production',
      effectiveBaseUrlHost: 'wallet.mwaloni.com',
      serviceId: 'SRV-00001',
      enabled: true,
      fields: {
        serviceId: {
          present: true,
          length: 9,
          trimmedLength: 9,
          hasLeadingWhitespace: false,
          hasTrailingWhitespace: false,
        },
        username: {
          present: true,
          length: 7,
          trimmedLength: 7,
          hasLeadingWhitespace: false,
          hasTrailingWhitespace: false,
          sha256: 'username-fingerprint',
        },
        password: {
          present: true,
          length: 10,
          trimmedLength: 10,
          hasLeadingWhitespace: false,
          hasTrailingWhitespace: false,
        },
        apiKey: {
          present: true,
          length: 64,
          trimmedLength: 64,
          hasLeadingWhitespace: false,
          hasTrailingWhitespace: false,
          sha256: 'api-key-fingerprint',
        },
      },
      requestShape: {
        endpoint: 'authenticate',
        method: 'POST',
        contentType: 'application/json',
        apiKeyHeader: 'x-api-key',
        authorizationHeaderSent: false,
        bodyFields: ['username', 'password'],
        usesTokenCache: false,
      },
      authResult: {
        attempted: true,
        success: false,
        status: '01',
        message: 'Invalid credentials',
        tokenReturned: false,
        tokenType: null,
        expiresIn: null,
        httpStatus: 200,
        errorCode: 'MWALONI_AUTH_REJECTED',
        retryable: false,
      },
    };
    (mockMpesaService.diagnoseMwaloniB2cAuthentication as jest.Mock).mockResolvedValueOnce(
      diagnostic,
    );

    await expect(
      controller.diagnoseMwaloniB2cAuthentication(
        { id: 'tenant-1' } as never,
        { id: 'super-1', role: UserRole.SUPER_ADMIN } as never,
      ),
    ).resolves.toEqual(diagnostic);
    expect(mockMpesaService.diagnoseMwaloniB2cAuthentication).toHaveBeenCalledWith(
      'super-1',
      'tenant-1',
    );
  });

  it('marks the Mwaloni auth diagnostic endpoint as SUPER_ADMIN only', () => {
    expect(Reflect.getMetadata(ROLES_KEY, controller.diagnoseMwaloniB2cAuthentication)).toEqual([
      UserRole.SUPER_ADMIN,
    ]);
  });
});
