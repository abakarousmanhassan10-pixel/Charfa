const { execSync } = require('child_process');
const path = require('path');

module.exports = async () => {
  require('./env-setup');
  // Fresh rate-limit windows for every run (counters live in Redis and would otherwise carry over).
  const Redis = require('ioredis');
  const redis = new Redis(process.env.REDIS_URL);
  const keys = await redis.keys('touma:rl:*');
  if (keys.length) await redis.del(...keys);
  // Jobs left in the AI queue by an interrupted run must not leak into this one.
  const queued = [...(await redis.keys('bull:touma.ai:*')), ...(await redis.keys('bull:touma.creative:*')), ...(await redis.keys('bull:touma.calendar:*'))];
  if (queued.length) await redis.del(...queued);
  await redis.quit();
  // Apply migrations exactly as production would (migrate deploy), against the test database.
  execSync('npx prisma migrate deploy', {
    cwd: path.resolve(__dirname, '../../../packages/database'),
    env: process.env,
    stdio: 'inherit',
  });
};
