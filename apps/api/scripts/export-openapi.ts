import 'reflect-metadata';
import { writeFileSync, mkdirSync } from 'fs';
import { resolve } from 'path';
import { loadEnv } from '@touma/config';
import { loadDotEnv } from '../src/load-dotenv';
import { buildOpenApi, createApp } from '../src/bootstrap';

async function run() {
  loadDotEnv();
  const app = await createApp(loadEnv(), { logger: false });
  await app.init();
  const out = resolve(__dirname, '../../../docs/api');
  mkdirSync(out, { recursive: true });
  writeFileSync(resolve(out, 'openapi.json'), JSON.stringify(buildOpenApi(app), null, 2));
  await app.close();
  console.log('Wrote docs/api/openapi.json');
  process.exit(0);
}
run().catch((e) => {
  console.error(e);
  process.exit(1);
});
