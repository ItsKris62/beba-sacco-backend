/**
 * test_redis.js — Verify Upstash Redis connection
 * Run: node test_redis.js
 */
const Redis = require('ioredis');

const client = new Redis({
  host: 'informed-newt-77715.upstash.io',
  port: 6379,
  password: 'gQAAAAAAAS-TAAIncDEzMGEzZjY5YmY2MTg0NDU5OTRlYmQyNjEyYjc5ZGRiMXAxNzc3MTU',
  tls: { rejectUnauthorized: false },
  connectTimeout: 10000,
  commandTimeout: 5000,
  lazyConnect: true,
});

async function main() {
  console.log('🔌 Connecting to Upstash Redis...');
  await client.connect();

  const pong = await client.ping();
  console.log('✅ PING response:', pong);

  await client.set('test:beba', 'hello-upstash', 'EX', 60);
  const val = await client.get('test:beba');
  console.log('✅ SET/GET test:', val);

  await client.del('test:beba');
  console.log('✅ DEL test: key cleaned up');

  console.log('\n🎉 Upstash Redis is working correctly!');
  console.log('   Host: informed-newt-77715.upstash.io:6379 (TLS)');
}

main()
  .catch(e => {
    console.error('❌ Redis connection failed:', e.message);
    process.exit(1);
  })
  .finally(() => client.disconnect());
