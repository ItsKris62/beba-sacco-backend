on the fronton the fronten.const http = require('http');
const body = JSON.stringify({ email: 'admin@beba-sacco.com', password: 'Admin@1234' });
const opts = {
  hostname: 'localhost', port: 3000, path: '/api/auth/login', method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Tenant-ID': 'b2ae96e2-2ad4-491a-8808-42152e2462a6', 'Content-Length': Buffer.byteLength(body) }
};
const req = http.request(opts, res => {
  let d = '';
  res.on('data', c => d += c);
  res.on('end', () => { console.log('Status:', res.statusCode); try { const j = JSON.parse(d); console.log(JSON.stringify(j, null, 2)); } catch { console.log(d); } });
});
req.on('error', e => console.error('Error:', e.message));
req.write(body);
req.end();
