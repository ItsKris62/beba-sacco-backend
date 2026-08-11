import { Test } from '@nestjs/testing';
import { LoanStatus, TransactionStatus } from '@prisma/client';
import { MpesaB2cTimeoutProcessor } from '../../src/modules/mpesa/processors/mpesa-b2c-timeout.processor';
import { MpesaService } from '../../src/modules/mpesa/mpesa.service';
import { PrismaService } from '../../src/prisma/prisma.service';

describe('B2C Timeout Handler', () => {
  const buildProcessor = async (loanStatus: LoanStatus) => {
    const tx = {
      mpesaTransaction: {
        findFirst: jest.fn(async () => ({ id: 'mpesa-tx-1', status: TransactionStatus.PENDING })),
        update: jest.fn(async () => undefined),
      },
      loan: {
        findFirst: jest.fn(async () => ({
          id: 'loan-1',
          tenantId: 'tenant-1',
          status: loanStatus,
        })),
        update: jest.fn(async () => undefined),
      },
      auditLog: {
        create: jest.fn(async () => undefined),
      },
    };

    const prisma = {
      directClient: {
        $transaction: jest.fn(async (callback: (txArg: typeof tx) => Promise<unknown>) =>
          callback(tx),
        ),
      },
    };
    const mpesaService = {
      refreshMwaloniB2cStatusByConversation: jest
        .fn()
        .mockResolvedValue({ refreshed: false, terminal: false }),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        MpesaB2cTimeoutProcessor,
        { provide: PrismaService, useValue: prisma },
        { provide: MpesaService, useValue: mpesaService },
      ],
    }).compile();

    return {
      processor: moduleRef.get(MpesaB2cTimeoutProcessor),
      tx,
      prisma,
    };
  };

  it('reverts DISBURSED loans to APPROVED and flags transaction for reconciliation', async () => {
    const { processor, tx } = await buildProcessor(LoanStatus.DISBURSED);

    await processor.process({
      id: 'b2c-timeout-test',
      data: {
        loanId: 'loan-1',
        tenantId: 'tenant-1',
        conversationId: 'conversation-1',
        referenceId: 'loan-1',
        referenceType: 'LOAN_DISBURSEMENT',
      },
    } as never);

    expect(tx.loan.update).toHaveBeenCalledWith({
      where: { id: 'loan-1' },
      data: {
        status: LoanStatus.APPROVED,
        disbursementFailureReason: 'B2C_TIMEOUT',
      },
    });
    expect(tx.mpesaTransaction.update).toHaveBeenCalledWith({
      where: { id: 'mpesa-tx-1' },
      data: {
        status: TransactionStatus.RECON_PENDING,
        failureReason: 'B2C_TIMEOUT',
        resultDesc: 'B2C callback not received before timeout window',
      },
    });
    expect(tx.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'B2C_TIMEOUT_REVERT',
          entityId: 'loan-1',
          tenantId: 'tenant-1',
        }),
      }),
    );
  });

  it('keeps APPROVED loans approved while flagging the timeout', async () => {
    const { processor, tx } = await buildProcessor(LoanStatus.APPROVED);

    await processor.process({
      id: 'b2c-timeout-approved-test',
      data: {
        loanId: 'loan-1',
        tenantId: 'tenant-1',
        conversationId: 'conversation-1',
        referenceId: 'loan-1',
        referenceType: 'LOAN_DISBURSEMENT',
      },
    } as never);

    expect(tx.loan.update).toHaveBeenCalledWith({
      where: { id: 'loan-1' },
      data: { disbursementFailureReason: 'B2C_TIMEOUT' },
    });
    expect(tx.mpesaTransaction.update).toHaveBeenCalled();
  });
});
