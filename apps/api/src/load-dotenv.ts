import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * Minimal .env loader for local development (root .env). Real environment variables always win.
 * Production deployments inject variables through the platform secret manager instead.
 */
export function loadDotEnv(file = resolve(__dirname, '../../../.env')) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    const [, key, raw] = m;
    if (process.env[key!] !== undefined) continue;
    process.env[key!] = raw!.replace(/^(['"])(.*)\1$/, '$2');
  }
}
