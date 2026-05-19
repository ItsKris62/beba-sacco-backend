import { Test, TestingModule } from '@nestjs/testing';
import { PinoLogger } from 'nestjs-pino';
import { OverpaymentHandlerService } from './overpayment-handler.service';
import { AuditService } from '../../audit/audit.service';
import { OverpaymentPolicy } from '../enums/overpayment-policy.enum';
import { Prisma } from '@prisma/client';

describe('OverpaymentHandlerService', () => {
  let service: OverpaymentHandlerService;
  let txMock: any;
  let auditServiceMock: any;

  beforeEach(async () => {
    auditServiceMock = { logEvent: jest.fn() };
    txMock = {
      fosaAccount: { update: jest.fn() },
      loanAdvance: { create: jest.fn().mockResolvedValue({ id: 'adv-123' }) },
      loan: { findFirst: jest.fn() },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OverpaymentHandlerService,
        { provide: PinoLogger, useValue: { setContext: jest.fn(), info: jest.fn() } },
        { provide: AuditService, useValue: auditServiceMock },
      ],
    }).compile();

    service = module.get<OverpaymentHandlerService>(OverpaymentHandlerService);
  });

  it('should fallback to RETURN_TO_FOSA and update balance', async () => {
    const result = await service.routeExcess(txMock, {
      tenantId: 't-1',
      memberId: 'm-1',
      loanId: 'l-1',
      fosaAccountId: 'f-1',
      excessAmount: new Prisma.Decimal('500.00'),
      policy: OverpaymentPolicy.RETURN_TO_FOSA,
      correlationId: 'req-123',
    });

    expect(txMock.fosaAccount.update).toHaveBeenCalledWith({
      where: { id: 'f-1', tenantId: 't-1' },
      data: { balance: { increment: new Prisma.Decimal('500.00') } },
    });
    expect(result.targetId).toBe('f-1');
    expect(auditServiceMock.logEvent).toHaveBeenCalledWith(txMock, expect.objectContaining({
      action: 'LOAN.OVERPAYMENT_HANDLED',
      details: expect.objectContaining({ policy: OverpaymentPolicy.RETURN_TO_FOSA })
    }));
  });

  it('should create a LoanAdvance when policy is HOLD_AS_ADVANCE', async () => {
    const result = await service.routeExcess(txMock, {
      tenantId: 't-1',
      memberId: 'm-1',
      loanId: 'l-1',
      fosaAccountId: 'f-1',
      excessAmount: new Prisma.Decimal('200.00'),
      policy: OverpaymentPolicy.HOLD_AS_ADVANCE,
      correlationId: 'req-123',
    });

    expect(txMock.loanAdvance.create).toHaveBeenCalledWith({
      data: {
        tenantId: 't-1',
        memberId: 'm-1',
        sourceLoanId: 'l-1',
        amount: new Prisma.Decimal('200.00'),
        status: 'HELD',
      }
    });
    expect(result.targetId).toBe('adv-123');
    expect(result.policyApplied).toBe(OverpaymentPolicy.HOLD_AS_ADVANCE);
  });

  it('should apply to next loan by creating earmarked advance', async () => {
    txMock.loan.findFirst.mockResolvedValueOnce({ id: 'l-2', status: 'ARREARS' });

    const result = await service.routeExcess(txMock, {
      tenantId: 't-1',
      memberId: 'm-1',
      loanId: 'l-1',
      fosaAccountId: 'f-1',
      excessAmount: new Prisma.Decimal('300.00'),
      policy: OverpaymentPolicy.APPLY_TO_NEXT_LOAN,
      correlationId: 'req-123',
    });

    expect(txMock.loanAdvance.create).toHaveBeenCalledWith({
      data: {
        tenantId: 't-1',
        memberId: 'm-1',
        sourceLoanId: 'l-1',
        amount: new Prisma.Decimal('300.00'),
        status: 'HELD_FOR_NEXT_LOAN',
      }
    });
    expect(result.targetId).toBe('adv-123');
    expect(result.policyApplied).toBe(OverpaymentPolicy.APPLY_TO_NEXT_LOAN);
  });

  it('should fallback to RETURN_TO_FOSA if no next loan is found for APPLY_TO_NEXT_LOAN', async () => {
    txMock.loan.findFirst.mockResolvedValue(null);

    const result = await service.routeExcess(txMock, {
      tenantId: 't-1',
      memberId: 'm-1',
      loanId: 'l-1',
      fosaAccountId: 'f-1',
      excessAmount: new Prisma.Decimal('150.00'),
      policy: OverpaymentPolicy.APPLY_TO_NEXT_LOAN,
      correlationId: 'req-123',
    });

    expect(txMock.fosaAccount.update).toHaveBeenCalled();
    expect(result.targetId).toBe('f-1');
    expect(result.policyApplied).toBe(OverpaymentPolicy.RETURN_TO_FOSA);
  });
});