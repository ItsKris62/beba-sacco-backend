import { INestApplication, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { TransactionStatus, UserRole } from '@prisma/client';
import { MpesaController } from '../../src/modules/mpesa/mpesa.controller';
import { MpesaService } from '../../src/modules/mpesa/mpesa.service';
import { ConfigService } from '@nestjs/config';

describe('STK Polling Endpoint', () => {
  let app: INestApplication;
  const getTransactionStatus = jest.fn();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [MpesaController],
      providers: [
        {
          provide: MpesaService,
          useValue: {
            getTransactionStatus,
          },
        },
        {
          provide: ConfigService,
          useValue: {
            get: (key: string, fallback?: unknown) =>
              ({
                'app.mpesa.webhookSecret': 'test-secret',
                'app.nodeEnv': 'test',
                'app.mpesa.allowedIps': [],
                'app.mpesa.environment': 'sandbox',
              })[key] ?? fallback,
          },
        },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.use((req: Request, _res: Response, next: NextFunction) => {
      const scopedRequest = req as Request & {
        tenant: { id: string };
        user: { id: string; email: string; role: UserRole; tenantId: string };
      };
      scopedRequest.tenant = { id: 'tenant-1' };
      scopedRequest.user = {
        id: 'user-1',
        email: 'member@test.co.ke',
        role: UserRole.MEMBER,
        tenantId: 'tenant-1',
      };
      next();
    });
    await app.init();
  });

  afterEach(() => {
    getTransactionStatus.mockReset();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('returns the current STK transaction status for the authenticated user and tenant', async () => {
    getTransactionStatus.mockResolvedValueOnce({
      checkoutRequestId: 'checkout-1',
      status: TransactionStatus.PENDING,
      amount: '1500.0000',
      lastUpdated: new Date('2026-05-17T10:30:00.000Z'),
    });

    await request(app.getHttpServer())
      .get('/api/mpesa/transactions/checkout-1/status')
      .expect(200)
      .expect((res) => {
        expect(res.body).toMatchObject({
          checkoutRequestId: 'checkout-1',
          status: TransactionStatus.PENDING,
          amount: '1500.0000',
        });
      });

    expect(getTransactionStatus).toHaveBeenCalledWith('checkout-1', 'user-1', 'tenant-1');
  });

  it('returns 404 for transactions the service cannot find in the tenant/user scope', async () => {
    getTransactionStatus.mockRejectedValueOnce(
      new NotFoundException('M-Pesa transaction not found'),
    );

    await request(app.getHttpServer()).get('/api/mpesa/transactions/missing/status').expect(404);
  });
});
