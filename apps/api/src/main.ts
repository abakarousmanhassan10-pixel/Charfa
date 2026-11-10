import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { loadEnv } from '@aima/config';
import { loadDotEnv } from './load-dotenv';
import { createApp } from './bootstrap';

async function main() {
  loadDotEnv();
  const env = loadEnv();
  const app = await createApp(env);
  await app.listen(env.API_PORT);
  Logger.log(`AIMA API listening on :${env.API_PORT}`, 'Bootstrap');
}

main().catch((err) => {
  // Configuration errors list variable names only, never values.
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
