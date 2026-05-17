import { Test } from '@nestjs/testing';
import { TransactionStatus, MpesaTxType } from '@prisma/client';
import { StkExpiryProcessor } from '../../src/modules/mpesa/jobs/stk-expiry.processor';
import { PrismaService } from '../../src/prisma/prisma.service';

describe('STK Expiry Sweep', () => {
  it('marks pending STK transactions older than 10 minutes as failed', async () => {
    const updateMany = jest.fn(async () => ({ count: 2 }));

    const moduleRef = await Test.createTestingModule({
      providers: [
        StkExpiryProcessor,
        {
          provide: PrismaService,
          useValue: {
            client: {
              mpesaTransaction: { updateMany },
            },
          },
        },
      ],
    }).compile();

    const processor = moduleRef.get(StkExpiryProcessor);
    await processor.process({ id: 'stk-expiry-test' } as never);

    expect(updateMany).toHaveBeenCalledWith({
      where: {
        status: TransactionStatus.PENDING,
        type: MpesaTxType.STK_PUSH,
        createdAt: { lt: expect.any(Date) },
      },
      data: {
        status: TransactionStatus.FAILED,
        failureReason: 'STK_TIMEOUT_SWEEP',
        resultDesc: 'STK push timed out without a Daraja callback',
      },
    });
  });
});
