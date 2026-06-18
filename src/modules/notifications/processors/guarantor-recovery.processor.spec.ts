import { Decimal } from 'decimal.js';
import { Job, Queue } from 'bullmq';
import { GuarantorStatus, LoanStatus } from '@prisma/client';
import { GuarantorRecoveryProcessor } from './guarantor-recovery.processor';
import {
  ExecuteGuarantorDebitJobPayload,
  GUARANTOR_DEBIT_JOB,
  GUARANTOR_RECOVERY_NOTICE_JOB,
  InitiateGuarantorRecoveryJobPayload,
} from '../../queue/queue.constants';

type MockFn = jest.Mock;

describe('GuarantorRecoveryProcessor', () => {
  const tenantId = 'tenant-1';
  const loanId = 'loan-1';

  function buildProcessor(args: { status?: LoanStatus; arrearsDays?: number } = {}) {
    const loan = {
      id: loanId,
      tenantId,
      loanNumber: 'LN-1',
      status: args.status ?? LoanStatus.DEFAULTED,
      arrearsDays: args.arrearsDays ?? 14,
      member: { user: { firstName: 'Borrower', lastName: 'One' } },
      guarantors: [
        {
          id: 'guarantor-row-1',
          memberId: 'guarantor-member-1',
          status: GuarantorStatus.ACCEPTED,
          recoveredAmount: new Decimal('0'),
          member: {
            user: {
              firstName: 'Guarantor',
              email: 'g@example.com',
              phone: '254711111111',
              phoneNumber: null,
            },
          },
        },
      ],
    };
    const prisma = {
      loan: { findFirst: jest.fn().mockResolvedValue(loan) },
      loanGuarantor: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'guarantor-row-1',
            memberId: 'guarantor-member-1',
            recoveredAmount: new Decimal('100'),
            member: { user: { firstName: 'Guarantor', email: 'g@example.com', phone: '254711111111', phoneNumber: null } },
          },
        ]),
      },
      notificationLog: { create: jest.fn().mockResolvedValue({}) },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
    };
    const recovery = {
      recoverFromGuarantors: jest.fn().mockResolvedValue({
        recoverySummary: { totalRecovered: new Decimal('100'), remainingDebt: new Decimal('0') },
      }),
    };
    const recoveryQueue = { add: jest.fn().mockResolvedValue({}) };
    const smsQueue = { add: jest.fn().mockResolvedValue({}) };
    const emailQueue = { add: jest.fn().mockResolvedValue({}) };
    const processor = new GuarantorRecoveryProcessor(
      prisma as unknown as ConstructorParameters<typeof GuarantorRecoveryProcessor>[0],
      recovery as unknown as ConstructorParameters<typeof GuarantorRecoveryProcessor>[1],
      recoveryQueue as unknown as Queue<InitiateGuarantorRecoveryJobPayload | ExecuteGuarantorDebitJobPayload>,
      smsQueue as unknown as ConstructorParameters<typeof GuarantorRecoveryProcessor>[3],
      emailQueue as unknown as ConstructorParameters<typeof GuarantorRecoveryProcessor>[4],
    );
    return { processor, prisma, recovery, recoveryQueue, smsQueue, emailQueue };
  }

  it('sends guarantor notices and schedules delayed debit seven days later', async () => {
    const { processor, recoveryQueue, smsQueue, emailQueue } = buildProcessor();

    await processor.process({
      name: GUARANTOR_RECOVERY_NOTICE_JOB,
      data: {
        tenantId,
        loanId,
        actorId: 'manager-1',
        defaultAmount: '1000',
        noticeDateIso: new Date().toISOString(),
      },
    } as Job<InitiateGuarantorRecoveryJobPayload>);

    expect(smsQueue.add as MockFn).toHaveBeenCalledWith('send', expect.objectContaining({ type: 'GUARANTOR_RECOVERY_NOTICE' }), expect.any(Object));
    expect(emailQueue.add as MockFn).toHaveBeenCalledWith('send', expect.objectContaining({ type: 'SYSTEM_NOTICE' }), expect.any(Object));
    expect(recoveryQueue.add as MockFn).toHaveBeenCalledWith(
      GUARANTOR_DEBIT_JOB,
      expect.objectContaining({ tenantId, loanId, defaultAmount: '1000' }),
      expect.objectContaining({ delay: expect.any(Number) }),
    );
  });

  it('executes delayed debit only when loan is still defaulted', async () => {
    const { processor, recovery } = buildProcessor();

    await processor.process({
      name: GUARANTOR_DEBIT_JOB,
      data: {
        tenantId,
        loanId,
        actorId: 'SYSTEM',
        defaultAmount: '100',
        executeAfterIso: new Date().toISOString(),
      },
    } as Job<ExecuteGuarantorDebitJobPayload>);

    expect(recovery.recoverFromGuarantors as MockFn).toHaveBeenCalledWith(loanId, tenantId, new Decimal('100'), 'SYSTEM');
  });

  it('skips delayed debit when borrower has cured default', async () => {
    const { processor, recovery } = buildProcessor({ status: LoanStatus.ACTIVE, arrearsDays: 0 });

    await processor.process({
      name: GUARANTOR_DEBIT_JOB,
      data: {
        tenantId,
        loanId,
        actorId: 'SYSTEM',
        defaultAmount: '100',
        executeAfterIso: new Date().toISOString(),
      },
    } as Job<ExecuteGuarantorDebitJobPayload>);

    expect(recovery.recoverFromGuarantors as MockFn).not.toHaveBeenCalled();
  });
});
