import { EmailProcessor } from '../../src/modules/queue/processors/email.processor';
import { InterestAccrualProcessor } from '../../src/modules/queue/processors/interest-accrual.processor';
import {
  ADVANCED_FINANCIAL_QUEUE_PROCESSOR_PROVIDERS,
  getQueueProcessorProviders,
  QUEUE_PROCESSOR_PROVIDERS,
  shouldRegisterQueueProcessors,
} from '../../src/modules/queue/queue.module';

describe('Worker Mode Queue Registration', () => {
  const originalWorkerMode = process.env.WORKER_MODE;
  const originalAdvancedFinancialJobs = process.env.FEATURE_ADVANCED_FINANCIAL_JOBS;
  const originalPhase4Enabled = process.env.PHASE_4_ENABLED;

  afterEach(() => {
    if (originalWorkerMode === undefined) {
      delete process.env.WORKER_MODE;
    } else {
      process.env.WORKER_MODE = originalWorkerMode;
    }

    if (originalAdvancedFinancialJobs === undefined) {
      delete process.env.FEATURE_ADVANCED_FINANCIAL_JOBS;
    } else {
      process.env.FEATURE_ADVANCED_FINANCIAL_JOBS = originalAdvancedFinancialJobs;
    }

    if (originalPhase4Enabled === undefined) {
      delete process.env.PHASE_4_ENABLED;
    } else {
      process.env.PHASE_4_ENABLED = originalPhase4Enabled;
    }
  });

  it('keeps web fallback processors registered while WORKER_MODE is false', () => {
    process.env.WORKER_MODE = 'false';
    process.env.FEATURE_ADVANCED_FINANCIAL_JOBS = 'false';
    delete process.env.PHASE_4_ENABLED;

    expect(shouldRegisterQueueProcessors({ mode: 'web' })).toBe(true);
    expect(getQueueProcessorProviders({ mode: 'web' })).toContain(EmailProcessor);
  });

  it('registers processors in the dedicated worker process', () => {
    process.env.WORKER_MODE = 'true';
    process.env.FEATURE_ADVANCED_FINANCIAL_JOBS = 'false';
    delete process.env.PHASE_4_ENABLED;

    expect(shouldRegisterQueueProcessors({ mode: 'worker' })).toBe(true);
    expect(getQueueProcessorProviders({ mode: 'worker' })).toEqual(
      expect.arrayContaining(QUEUE_PROCESSOR_PROVIDERS),
    );
  });

  it('can disable web fallback processors after the worker service is enabled', () => {
    process.env.WORKER_MODE = 'true';
    process.env.FEATURE_ADVANCED_FINANCIAL_JOBS = 'false';
    delete process.env.PHASE_4_ENABLED;

    expect(shouldRegisterQueueProcessors({ mode: 'web' })).toBe(false);
    expect(getQueueProcessorProviders({ mode: 'web' })).not.toContain(EmailProcessor);
  });

  it('keeps advanced financial processors disabled by default', () => {
    process.env.WORKER_MODE = 'true';
    process.env.FEATURE_ADVANCED_FINANCIAL_JOBS = 'false';
    delete process.env.PHASE_4_ENABLED;

    expect(getQueueProcessorProviders({ mode: 'worker' })).not.toContain(InterestAccrualProcessor);
  });

  it('registers advanced financial processors when FEATURE_ADVANCED_FINANCIAL_JOBS is true', () => {
    process.env.WORKER_MODE = 'true';
    process.env.FEATURE_ADVANCED_FINANCIAL_JOBS = 'true';
    delete process.env.PHASE_4_ENABLED;

    expect(getQueueProcessorProviders({ mode: 'worker' })).toEqual(
      expect.arrayContaining(ADVANCED_FINANCIAL_QUEUE_PROCESSOR_PROVIDERS),
    );
  });
});
