import { WithdrawalReconciliationProcessor } from './withdrawal-recon.processor';

describe('WithdrawalReconciliationProcessor', () => {
  it('delegates the sweep to the reconciliation service', async () => {
    const reconciliation = {
      runAutomatedSweep: jest
        .fn()
        .mockResolvedValue({ reconciled: 1, staleOutbox: 2, anomalies: 3 }),
    };
    const audit = { create: jest.fn().mockResolvedValue(undefined) };
    const processor = new WithdrawalReconciliationProcessor(
      reconciliation as never,
      audit as never,
    );

    await processor.process({ id: 'job-1' } as never);

    expect(reconciliation.runAutomatedSweep).toHaveBeenCalledWith('job-1');
  });

  it('audits a failed reconciliation queue job as DLQ-visible', async () => {
    const reconciliation = { runAutomatedSweep: jest.fn() };
    const audit = { create: jest.fn().mockResolvedValue(undefined) };
    const processor = new WithdrawalReconciliationProcessor(
      reconciliation as never,
      audit as never,
    );

    await processor.onFailed({ id: 'job-1', failedReason: 'boom', attemptsMade: 3 } as never);

    expect(audit.create).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'MPESA.WITHDRAWAL.RECON_DLQ',
        entityType: 'QueueJob',
        entityId: 'job-1',
      }),
    );
  });
});
