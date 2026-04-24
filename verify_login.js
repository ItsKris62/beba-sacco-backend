const http = require('http');
const fs = require('fs');
const path = require('path');

const OUTPUT_FILE = path.join(__dirname, 'verify_login_output.txt');
const lines = [];
function log(msg) { lines.push(msg); console.log(msg); }

const TENANT_ID = 'b2ae96e2-2ad4-491a-8808-42152e2462a6';

function testLogin(email, password, label) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ email, password });
    const opts = {
      hostname: 'localhost', port: 3001, path: '/api/auth/login', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Tenant-ID': TENANT_ID, 'Content-Length': Buffer.byteLength(body) }
    };
    const req = http.request(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        log('--- ' + label + ' ---');
        log('Status: ' + res.statusCode);
        try {
          const j = JSON.parse(d);
          if (res.statusCode === 200 || res.statusCode === 201) {
            log('LOGIN SUCCESS');
            log('User: ' + j.user?.email + ' | Role: ' + j.user?.role);
            log('Access token: ' + (j.accessToken ? j.accessToken.slice(0, 30) + '...' : 'NONE'));
          } else {
            log('LOGIN FAILED: ' + j.message);
          }
        } catch { log('Raw: ' + d); }
        resolve();
      });
    });
    req.on('error', e => { log('--- ' + label + ' ---'); log('CONNECTION ERROR: ' + e.message); resolve(); });
    req.write(body);
    req.end();
  });
}

async function run() {
  log('=== TESTING DEMO ACCOUNT LOGINS ===');
  log('Backend: http://localhost:3001');
  log('Tenant ID: ' + TENANT_ID);
  log('');
  await testLogin('admin@beba-sacco.com', 'Admin@1234', 'ADMIN (admin@beba-sacco.com / Admin@1234)');
  log('');
  await testLogin('member@beba-sacco.com', 'Member@1234', 'MEMBER (member@beba-sacco.com / Member@1234)');
  log('');
  log('=== DONE ===');
  fs.writeFileSync(OUTPUT_FILE, lines.join('\n'), 'utf8');
}

run().catch(e => { log('FATAL: ' + e.message); fs.writeFileSync(OUTPUT_FILE, lines.join('\n'), 'utf8'); });
