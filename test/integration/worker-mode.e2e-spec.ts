import { EmailProcessor } from '../../src/modules/queue/processors/email.processor';
import {
  getQueueProcessorProviders,
  QUEUE_PROCESSOR_PROVIDERS,
  shouldRegisterQueueProcessors,
} from '../../src/modules/queue/queue.module';

describe('Worker Mode Queue Registration', () => {
  const originalWorkerMode = process.env.WORKER_MODE;

  afterEach(() => {
    if (originalWorkerMode === undefined) {
      delete process.env.WORKER_MODE;
    } else {
      process.env.WORKER_MODE = originalWorkerMode;
    }
  });

  it('keeps web fallback processors registered while WORKER_MODE is false', () => {
    process.env.WORKER_MODE = 'false';

    expect(shouldRegisterQueueProcessors({ mode: 'web' })).toBe(true);
    expect(getQueueProcessorProviders({ mode: 'web' })).toContain(EmailProcessor);
  });

  it('registers processors in the dedicated worker process', () => {
    process.env.WORKER_MODE = 'true';

    expect(shouldRegisterQueueProcessors({ mode: 'worker' })).toBe(true);
    expect(getQueueProcessorProviders({ mode: 'worker' })).toEqual(
      expect.arrayContaining(QUEUE_PROCESSOR_PROVIDERS),
    );
  });

  it('can disable web fallback processors after the worker service is enabled', () => {
    process.env.WORKER_MODE = 'true';

    expect(shouldRegisterQueueProcessors({ mode: 'web' })).toBe(false);
    expect(getQueueProcessorProviders({ mode: 'web' })).not.toContain(EmailProcessor);
  });
});
