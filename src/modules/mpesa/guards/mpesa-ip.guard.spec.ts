import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import { MpesaIpGuard } from './mpesa-ip.guard';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const SAFARICOM_IP = '196.201.214.200';
const ALLOWED = [SAFARICOM_IP, '196.201.214.206'];

function makeConfig(env: string, ips: string[]): ConfigService {
  return {
    get: jest.fn((key: string, def?: unknown) => {
      if (key === 'app.mpesa.allowedIps') return ips;
      if (key === 'app.mpesa.environment') return env;
      return def;
    }),
  } as unknown as ConfigService;
}

function makeCtx(req: Partial<Request>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

// ─── Suite ───────────────────────────────────────────────────────────────────

describe('MpesaIpGuard', () => {

  // ── Sandbox / no-config bypass ──────────────────────────────────────────

  it('passes all traffic in sandbox mode (no enforcement)', () => {
    const guard = new MpesaIpGuard(makeConfig('sandbox', ALLOWED));
    const ctx = makeCtx({ ip: '1.2.3.4' });
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('passes all traffic when MPESA_ALLOWED_IPS is empty in production', () => {
    const guard = new MpesaIpGuard(makeConfig('production', []));
    const ctx = makeCtx({ ip: '1.2.3.4' });
    expect(guard.canActivate(ctx)).toBe(true);
  });

  // ── IP resolution: rightmost-wins ─────────────────────────────────────

  it('[C-2] uses rightmost X-Forwarded-For IP (Render appends true client IP last)', () => {
    const guard = new MpesaIpGuard(makeConfig('production', ALLOWED));
    const ctx = makeCtx({
      headers: { 'x-forwarded-for': `${SAFARICOM_IP}, 10.0.0.1` },
      socket: { remoteAddress: '10.0.0.1' } as never,
    });
    // Rightmost is '10.0.0.1' — NOT in allowlist → blocked
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it('[C-2] attacker forging leftmost IP is blocked by rightmost check', () => {
    const guard = new MpesaIpGuard(makeConfig('production', ALLOWED));
    // Attacker puts a Safaricom IP first; Render appends their real IP last
    const ctx = makeCtx({
      headers: { 'x-forwarded-for': `${SAFARICOM_IP}, 9.9.9.9` },
    });
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it('[C-2] allows a legitimate Safaricom IP when it is the rightmost entry', () => {
    const guard = new MpesaIpGuard(makeConfig('production', ALLOWED));
    const ctx = makeCtx({
      headers: { 'x-forwarded-for': `10.0.0.1, ${SAFARICOM_IP}` },
    });
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('[C-2] handles array-form X-Forwarded-For (multi-header lines)', () => {
    const guard = new MpesaIpGuard(makeConfig('production', ALLOWED));
    // Some proxies send multiple header lines; Express surfaces them as an array
    const ctx = makeCtx({
      headers: { 'x-forwarded-for': ['10.0.0.1', SAFARICOM_IP] as unknown as string },
    });
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('[C-2] falls back to req.ip when X-Forwarded-For is absent', () => {
    const guard = new MpesaIpGuard(makeConfig('production', ALLOWED));
    const ctx = makeCtx({ ip: SAFARICOM_IP, headers: {} });
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('[C-2] falls back to socket.remoteAddress when ip is absent', () => {
    const guard = new MpesaIpGuard(makeConfig('production', ALLOWED));
    const ctx = makeCtx({
      headers: {},
      socket: { remoteAddress: SAFARICOM_IP } as never,
    });
    expect(guard.canActivate(ctx)).toBe(true);
  });

  // ── Enforcement: allow/deny ────────────────────────────────────────────

  it('allows requests from an IP in the allowlist (production, single IP)', () => {
    const guard = new MpesaIpGuard(makeConfig('production', ALLOWED));
    const ctx = makeCtx({
      headers: { 'x-forwarded-for': SAFARICOM_IP },
    });
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('throws ForbiddenException for an unlisted IP in production', () => {
    const guard = new MpesaIpGuard(makeConfig('production', ALLOWED));
    const ctx = makeCtx({
      headers: { 'x-forwarded-for': '8.8.8.8' },
    });
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });
});
