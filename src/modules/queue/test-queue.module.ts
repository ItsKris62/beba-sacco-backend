import { Module } from '@nestjs/common';
import { getQueueToken } from '@nestjs/bullmq';
import { QUEUE_NAMES } from './queue.constants';

// Simple mock queue used across tests
const mockQueue = {
  add: jest.fn().mockResolvedValue({ id: 'mock-job' }),
  pause: jest.fn(),
  resume: jest.fn(),
  // Add other methods as needed for tests
} as any;

@Module({
  providers: [
    { provide: getQueueToken(QUEUE_NAMES.MPESA_CALLBACK), useValue: mockQueue },
    { provide: getQueueToken(QUEUE_NAMES.MPESA_DISBURSEMENT), useValue: mockQueue },
    { provide: getQueueToken(QUEUE_NAMES.MPESA_DISBURSEMENT_DLQ), useValue: mockQueue },
    { provide: getQueueToken(QUEUE_NAMES.MPESA_B2C_TIMEOUT), useValue: mockQueue },
    { provide: getQueueToken(QUEUE_NAMES.EMAIL), useValue: mockQueue },
    { provide: getQueueToken(QUEUE_NAMES.AUDIT_LOG), useValue: mockQueue },
  ],
  exports: [
    { provide: getQueueToken(QUEUE_NAMES.MPESA_CALLBACK), useValue: mockQueue },
    { provide: getQueueToken(QUEUE_NAMES.MPESA_DISBURSEMENT), useValue: mockQueue },
    { provide: getQueueToken(QUEUE_NAMES.MPESA_DISBURSEMENT_DLQ), useValue: mockQueue },
    { provide: getQueueToken(QUEUE_NAMES.MPESA_B2C_TIMEOUT), useValue: mockQueue },
    { provide: getQueueToken(QUEUE_NAMES.EMAIL), useValue: mockQueue },
    { provide: getQueueToken(QUEUE_NAMES.AUDIT_LOG), useValue: mockQueue },
  ],
})
export class TestQueueModule {}
