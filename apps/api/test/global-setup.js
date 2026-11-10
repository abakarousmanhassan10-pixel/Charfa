const { execSync } = require('child_process');
const path = require('path');

module.exports = async () => {
  require('./env-setup');
  // Apply migrations exactly as production would (migrate deploy), against the test database.
  execSync('npx prisma migrate deploy', {
    cwd: path.resolve(__dirname, '../../../packages/database'),
    env: process.env,
    stdio: 'inherit',
  });
};
