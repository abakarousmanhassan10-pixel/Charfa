#!/usr/bin/env node
// Bounded local load and resilience check (Node 22, no dependency). It starts the BUILT API itself (apps/api/dist, throwaway
// values from local-test.env, a local PostgreSQL and Redis) and never targets another host. Total work is capped: about 700 HTTP
// requests, 60 workflow runs, one process kill. Usage: node infrastructure/scripts/load-check.mjs   (build the API first)
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const env = Object.fromEntries(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), 'local-test.env'), 'utf8').split('\n').filter((l) => l && !l.startsWith('#')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const PORT = env.API_PORT, BASE = `http://127.0.0.1:${PORT}/api/v1`;
if (!/localhost|127\.0\.0\.1/.test(env.DATABASE_URL + env.REDIS_URL)) throw new Error('refused: local services only');
const DB = env.DATABASE_URL.split('?')[0];
const psql = (q) => execFileSync('psql', [DB, '-At', '-c', q]).toString().trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (a, p) => a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor((a.length * p) / 100))];
const stats = (a) => ({ n: a.length, p50: Math.round(pct(a, 50)), p95: Math.round(pct(a, 95)), p99: Math.round(pct(a, 99)), max: Math.round(Math.max(...a)) });
const results = {};

let api;
const start = async () => {
  api = spawn('node', ['dist/main.js'], { cwd: resolve(root, 'apps/api'), env: { ...process.env, ...env }, stdio: 'ignore' });
  for (let i = 0; i < 60; i++) { try { if ((await fetch(`${BASE}/health`)).ok) return; } catch { /* not yet */ } await sleep(500); }
  throw new Error('API did not start');
};
const stop = (sig = 'SIGTERM') => new Promise((res) => { if (!api) return res(); api.once('exit', res); api.kill(sig); });

async function pool(n, c, fn) { // n tasks, c at a time
  const times = []; let i = 0, errors = 0; const out = [];
  await Promise.all(Array.from({ length: c }, async () => { while (i < n) { const k = i++; const t = performance.now(); try { out[k] = await fn(k); } catch { errors++; } times.push(performance.now() - t); } }));
  return { times, errors, out };
}
async function call(token, biz, method, path, body, headers = {}) {
  const r = await fetch(BASE + path, { method, headers: { authorization: `Bearer ${token}`, ...(biz ? { 'x-business-id': biz } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
}
async function tenant(label) {
  const email = `load-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
  const reg = await (await fetch(`${BASE}/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'Correct-Horse-9-Battery', fullName: label }) })).json();
  const biz = await call(reg.accessToken, null, 'POST', '/businesses', { name: label, type: 'RESTAURANT', currency: 'XAF', city: 'Ndjamena', country: 'TD' });
  return { token: reg.accessToken, biz: biz.body.id };
}
const connections = () => Number(psql("select count(*) from pg_stat_activity where datname = current_database()"));
const wfDef = (approval) => ({ triggers: [{ type: 'manual' }], steps: [{ key: 'draft', adapter: 'simulated.content-draft' }, ...(approval ? [{ key: 'act', adapter: 'simulated.calendar-schedule', dependsOn: ['draft'], requiresApproval: true }] : [])] });
async function workflow(t, name, approval) {
  const wf = (await call(t.token, t.biz, 'POST', '/workflows', { name, definition: wfDef(approval) })).body;
  await call(t.token, t.biz, 'POST', `/workflows/${wf.id}/activate`, {});
  return wf.id;
}
const startRun = (t, wf, k) => call(t.token, t.biz, 'POST', `/workflows/${wf}/executions`, { input: {} }, { 'idempotency-key': `load-${wf}-${k}-${'x'.repeat(8)}` });
const runStatus = async (t, id) => (await call(t.token, t.biz, 'GET', `/runs/${id}`)).body?.status;
async function until(t, ids, status, ms = 30000) { const end = Date.now() + ms; for (;;) { const s = await Promise.all(ids.map((i) => runStatus(t, i))); if (s.every((x) => x === status)) return true; if (Date.now() > end) return s; await sleep(150); } }

try {
  await start();
  // A. API latency
  const a = await pool(300, 20, () => fetch(`${BASE}/health`).then((r) => { if (!r.ok) throw new Error(); }));
  results.health = { ...stats(a.times), errors: a.errors, concurrency: 20 };
  const A = await tenant('Load A'), B = await tenant('Load B');
  const before = connections();
  const b = await pool(300, 15, () => call(A.token, A.biz, 'GET', '/products').then((r) => { if (r.status !== 200) throw new Error(); }));
  results.authenticatedRead = { ...stats(b.times), errors: b.errors, concurrency: 15 };
  results.dbConnections = { idleBaseline: before, duringLoad: connections() };

  // B. concurrent workflow submissions against the tenant limit (5), tenant isolation of the budget
  const wfA = await workflow(A, 'Load flow A', false), wfB = await workflow(B, 'Load flow B', false);
  const burst = await Promise.all(Array.from({ length: 30 }, (_, k) => startRun(A, wfA, k)));
  const ok = burst.filter((r) => r.status === 201), refused = burst.filter((r) => r.status === 429);
  const otherTenant = await Promise.all(Array.from({ length: 5 }, (_, k) => startRun(B, wfB, k)));
  results.quota = { submitted: 30, accepted: ok.length, refused429: refused.length, otherTenantAccepted: otherTenant.filter((r) => r.status === 201).length, limit: 5 };
  await until(A, ok.map((r) => r.body.id), 'COMPLETED');

  // C. queue throughput: 8 batches of 5 runs (the per-tenant limit), time to completion
  const t0 = performance.now(); let done = 0;
  for (let batch = 0; batch < 8; batch++) {
    const rs = await Promise.all(Array.from({ length: 5 }, (_, k) => startRun(A, wfA, 1000 + batch * 5 + k)));
    const ids = rs.filter((r) => r.status === 201).map((r) => r.body.id);
    if ((await until(A, ids, 'COMPLETED')) === true) done += ids.length;
  }
  const secs = (performance.now() - t0) / 1000;
  results.throughput = { runs: done, seconds: Number(secs.toFixed(1)), runsPerSecond: Number((done / secs).toFixed(2)) };

  // D. process kill and recovery: runs waiting for approval must survive a SIGKILL; none may be executed twice
  const wfW = await workflow(A, 'Load flow approval', true);
  const waiting = await Promise.all(Array.from({ length: 5 }, (_, k) => startRun(A, wfW, k)));
  const ids = waiting.filter((r) => r.status === 201).map((r) => r.body.id);
  await stop('SIGKILL');
  const killedAt = Date.now();
  await start();
  const reached = await until(A, ids, 'WAITING_APPROVAL', 60000);
  const steps = psql(`select count(*) from "AgentRunStep" where "runId" in (${ids.map((i) => `'${i}'`).join(',')}) and key = 'draft' and attempts <> 1`);
  results.recovery = { runs: ids.length, reachedWaitingApprovalAfterRestart: reached === true, seconds: Number(((Date.now() - killedAt) / 1000).toFixed(1)), stepsExecutedMoreThanOnce: Number(steps) };
  for (const id of ids) await call(A.token, A.biz, 'POST', `/runs/${id}/steps/act/approve`, {});
  results.recovery.completedAfterApproval = (await until(A, ids, 'COMPLETED')) === true;
  const dup = psql(`select count(*) from (select "runId", key from "AgentRunStep" where "businessId" = '${A.biz}' group by 1, 2 having count(*) > 1) x`);
  results.recovery.duplicateSteps = Number(dup);
} finally {
  await stop();
}
console.log(JSON.stringify(results, null, 2));
const bad = results.health.errors || results.authenticatedRead.errors || results.quota.accepted > 5 || results.quota.otherTenantAccepted !== 5 || !results.recovery.reachedWaitingApprovalAfterRestart || results.recovery.stepsExecutedMoreThanOnce || results.recovery.duplicateSteps || !results.recovery.completedAfterApproval || results.throughput.runs !== 40;
console.log(bad ? 'LOAD CHECK FAILED' : 'LOAD CHECK OK');
process.exit(bad ? 1 : 0);
