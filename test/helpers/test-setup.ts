import * as path from 'path';
import * as dotenv from 'dotenv';

dotenv.config({ path: path.resolve(__dirname, '../../.env.test'), override: true });
/**
 * Jest E2E Test Setup
 *
 * Global configuration for E2E test suite:
 * - Extends jest timeout for integration tests
 * - Suppresses console noise during tests
 * - Validates required environment variables
 */
// TwoFactorService imports otplib, which pulls an ESM-only @scure/base build.
// Mock it for Jest E2E bootstrap; 2FA behavior is covered by focused auth tests.
jest.mock('../../src/modules/auth/two-factor.service', () => ({
  TwoFactorService: jest.fn().mockImplementation(() => ({
    generateSecret: jest.fn(),
    verifyToken: jest.fn(),
    verifyBackupCode: jest.fn(),
  })),
}));


// Extend default timeout for E2E tests (DB/Redis ops can be slow)
jest.setTimeout(60000);

// Suppress expected console warnings during tests
const originalConsoleWarn = console.warn;
const originalConsoleError = console.error;

beforeAll(() => {
  // Filter out known non-critical warnings
  console.warn = (...args: unknown[]) => {
    const msg = args.join(' ');
    if (
      msg.includes('Redis') ||
      msg.includes('BullMQ') ||
      msg.includes('degraded mode')
    ) {
      return;
    }
    originalConsoleWarn.apply(console, args);
  };

  console.error = (...args: unknown[]) => {
    const msg = args.join(' ');
    if (
      msg.includes('Audit write failed') ||
      msg.includes('EmailQueue') ||
      msg.includes('Redis error') ||
      msg.includes('WRONGPASS') ||
      msg.includes('ECONNREFUSED') ||
      msg.includes('AggregateError') ||
      msg.includes('[ioredis]')
    ) {
      return;
    }
    originalConsoleError.apply(console, args);
  };
});

afterAll(() => {
  console.warn = originalConsoleWarn;
  console.error = originalConsoleError;
});

