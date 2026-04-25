import * as crypto from 'crypto';
import { ConfigService } from '@nestjs/config';
import { MpesaController } from './mpesa.controller';
import { MpesaService } from './mpesa.service';

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
} as unknown as MpesaService;

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
    controller = new MpesaController(mockMpesaService, makeConfig(SECRET));
  });

  // ── Signature bypass in dev/sandbox ────────────────────────────────────

  it('accepts callback without a signature when no webhook secret is configured', async () => {
    const noSecretController = new MpesaController(
      mockMpesaService,
      makeConfig(undefined),
    );
    const rawBody = Buffer.from(JSON.stringify(STK_BODY));
    const result = await noSecretController.unifiedCallback(
      { rawBody } as never,
      STK_BODY as never,
      undefined,
    );
    expect(result).toEqual({ ResultCode: 0, ResultDesc: 'Accepted' });
    expect(mockMpesaService.enqueueCallback).toHaveBeenCalledWith(
      STK_BODY,
      'STK_PUSH',
      'ws_CO_1',
    );
  });

  // ── Signature validation ────────────────────────────────────────────────

  it('[C-3] accepts a callback with a valid HMAC-SHA256 signature', async () => {
    const rawBody = Buffer.from(JSON.stringify(STK_BODY));
    const sig = hmac(rawBody, SECRET);

    const result = await controller.unifiedCallback(
      { rawBody } as never,
      STK_BODY as never,
      sig,
    );
    expect(result).toEqual({ ResultCode: 0, ResultDesc: 'Accepted' });
    expect(mockMpesaService.enqueueCallback).toHaveBeenCalledTimes(1);
  });

  it('[C-3] silently ACKs and discards a callback with a missing signature', async () => {
    const rawBody = Buffer.from(JSON.stringify(STK_BODY));

    const result = await controller.unifiedCallback(
      { rawBody } as never,
      STK_BODY as never,
      undefined, // no signature
    );
    expect(result).toEqual({ ResultCode: 0, ResultDesc: 'Accepted' });
    expect(mockMpesaService.enqueueCallback).not.toHaveBeenCalled();
  });

  it('[C-3] silently ACKs and discards a callback with a tampered signature', async () => {
    const rawBody = Buffer.from(JSON.stringify(STK_BODY));
    const wrongSig = hmac(rawBody, 'different-secret');

    const result = await controller.unifiedCallback(
      { rawBody } as never,
      STK_BODY as never,
      wrongSig,
    );
    expect(result).toEqual({ ResultCode: 0, ResultDesc: 'Accepted' });
    expect(mockMpesaService.enqueueCallback).not.toHaveBeenCalled();
  });

  it('[C-3] silently ACKs and discards a callback with a non-hex signature string', async () => {
    const rawBody = Buffer.from(JSON.stringify(STK_BODY));

    const result = await controller.unifiedCallback(
      { rawBody } as never,
      STK_BODY as never,
      'not-a-hex-string!!',
    );
    expect(result).toEqual({ ResultCode: 0, ResultDesc: 'Accepted' });
    expect(mockMpesaService.enqueueCallback).not.toHaveBeenCalled();
  });

  // ── Payload routing ────────────────────────────────────────────────────

  it('routes a valid C2B callback to enqueueCallback with type C2B', async () => {
    const rawBody = Buffer.from(JSON.stringify(C2B_BODY));
    const sig = hmac(rawBody, SECRET);

    await controller.unifiedCallback({ rawBody } as never, C2B_BODY as never, sig);

    expect(mockMpesaService.enqueueCallback).toHaveBeenCalledWith(
      C2B_BODY,
      'C2B',
      'TXN123456',
    );
  });

  it('routes a valid B2C result callback to enqueueCallback with type B2C_RESULT', async () => {
    const rawBody = Buffer.from(JSON.stringify(B2C_BODY));
    const sig = hmac(rawBody, SECRET);

    await controller.unifiedCallback({ rawBody } as never, B2C_BODY as never, sig);

    expect(mockMpesaService.enqueueCallback).toHaveBeenCalledWith(
      B2C_BODY,
      'B2C_RESULT',
      'conv-abc',
    );
  });

  it('classifies a B2C result with ResultCode 17 as B2C_TIMEOUT', async () => {
    const timeoutBody = {
      Result: { ...B2C_BODY.Result, ResultCode: 17, ResultDesc: 'request cancelled' },
    };
    const rawBody = Buffer.from(JSON.stringify(timeoutBody));
    const sig = hmac(rawBody, SECRET);

    await controller.unifiedCallback({ rawBody } as never, timeoutBody as never, sig);

    expect(mockMpesaService.enqueueCallback).toHaveBeenCalledWith(
      timeoutBody,
      'B2C_TIMEOUT',
      'conv-abc',
    );
  });
});
