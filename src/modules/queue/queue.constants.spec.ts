import { QUEUE_NAMES, guarantorForfeitureReference } from './queue.constants';

describe('QUEUE_NAMES', () => {
  it('uses BullMQ-safe queue names', () => {
    for (const [key, name] of Object.entries(QUEUE_NAMES)) {
      expect(name).not.toContain(':');
      expect(name).toMatch(/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/);
      expect(name).toBe(name.toLowerCase());
      expect(name).toBe(name.trim());
      expect(name).not.toContain('..');
      expect(name).not.toContain('--');

      if (!name) {
        throw new Error(`${key} must not be empty`);
      }
    }
  });
});

describe('guarantorForfeitureReference', () => {
  it('includes a recovery attempt suffix after tenant, loan, and account ids', () => {
    expect(
      guarantorForfeitureReference('tenant-1', 'loan-1', 'account-1', 'attempt-1'),
    ).toBe('GUAR_FORFEIT-tenant-1-loan-1-account-1-attempt-1');
  });
});
