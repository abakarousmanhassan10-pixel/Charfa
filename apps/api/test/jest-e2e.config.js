/** API integration tests: real PostgreSQL + Redis (test database), no mocks. */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  testRegex: '\\.e2e-spec\\.ts$',
  globalSetup: '<rootDir>/global-setup.js',
  setupFiles: ['<rootDir>/env-setup.js'],
  testTimeout: 30000,
  // argon2's native thread pool can keep the process alive briefly after all handles are closed.
  forceExit: true,
};
