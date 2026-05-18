import request from 'supertest';
import { createServer } from 'http';
import { createHmac } from 'crypto';

describe('P0 production fixes scaffolds', () => {
  it('documents M-PESA callback ACK contract', async () => {
    const server = createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/api/mpesa/callback') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ResultCode: 0, ResultDesc: 'Accepted' }));
        return;
      }
      res.writeHead(404);
      res.end();
    });

    const body = JSON.stringify({ Body: { stkCallback: { CheckoutRequestID: 'ws_CO_test' } } });
    const signature = createHmac('sha256', 'test_secret_which_is_long_enough')
      .update(Buffer.from(body))
      .digest('hex');

    await request(server)
      .post('/api/mpesa/callback')
      .set('X-Mpesa-Signature', signature)
      .set('X-Mpesa-Timestamp', new Date().toISOString())
      .send(JSON.parse(body))
      .expect(200)
      .expect({ ResultCode: 0, ResultDesc: 'Accepted' });
  });

  it.todo('rejects reused X-Idempotency-Key with IDEMPOTENCY_KEY_MISMATCH when body hash differs');
  it.todo('replays cached 200/201 responses with X-Idempotency-Replayed=true');
  it.todo('persists AuditEvent rows with prevHash/eventHash/HMAC and verifies chain tampering');
  it.todo('creates audit_archive_manifests without updating or deleting AuditEvent rows');
});
