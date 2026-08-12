import { AdminReconciliationService } from '../admin-reconciliation.service';

describe('AdminReconciliationService', () => {
  it('delegates list and action-specific commands to WithdrawalReconciliationService', async () => {
    const withdrawalRecon = {
      listOperationalCases: jest.fn().mockResolvedValue({ data: [], total: 0 }),
      refreshProviderStatus: jest.fn().mockResolvedValue({ action: 'REFRESH_PROVIDER_STATUS' }),
      markCompletedWithEvidence: jest.fn().mockResolvedValue({ action: 'MANUAL_COMPLETE' }),
      reverseConfirmedFailure: jest.fn().mockResolvedValue({ action: 'MANUAL_REVERSE' }),
      controlledResend: jest.fn().mockResolvedValue({ action: 'CONTROLLED_RESEND_BLOCKED' }),
    };
    const service = new AdminReconciliationService(withdrawalRecon as never);

    await service.listPending('tenant-1', { limit: 10 });
    await service.refreshStatus(
      'mtx-1',
      { reason: 'check now' },
      'tenant-1',
      'admin-1',
      '127.0.0.1',
    );
    await service.markCompleted(
      'mtx-1',
      { reason: 'provider proof', evidenceReference: 'SR-1' },
      'tenant-1',
      'admin-1',
    );
    await service.reverseConfirmedFailure(
      'mtx-1',
      { reason: 'provider failure proof', evidenceReference: 'SR-2' },
      'tenant-1',
      'admin-1',
    );
    await service.controlledResend(
      'mtx-1',
      { reason: 'provider non-submission proof', evidenceReference: 'SR-3' },
      'tenant-1',
      'admin-1',
    );

    expect(withdrawalRecon.listOperationalCases).toHaveBeenCalledWith('tenant-1', { limit: 10 });
    expect(withdrawalRecon.refreshProviderStatus).toHaveBeenCalledWith(
      'mtx-1',
      'tenant-1',
      'admin-1',
      { reason: 'check now' },
      '127.0.0.1',
    );
    expect(withdrawalRecon.markCompletedWithEvidence).toHaveBeenCalled();
    expect(withdrawalRecon.reverseConfirmedFailure).toHaveBeenCalled();
    expect(withdrawalRecon.controlledResend).toHaveBeenCalled();
  });
});
