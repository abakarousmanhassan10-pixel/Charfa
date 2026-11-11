/**
 * TOUMA live integration verification (operator tool, never part of automated tests).
 *
 * Runs the REAL platform adapters against REAL platform APIs with credentials YOU supply for authorized DEVELOPMENT accounts.
 * Every step is reported as PASSED, FAILED or SKIPPED with the reason. Nothing is simulated: a step without credentials or
 * network access is SKIPPED, never "passed". Tokens are never printed.
 *
 *   npx ts-node -T scripts/live-verify.ts                # read-only: OAuth config, token, permissions, account listing
 *   npx ts-node -T scripts/live-verify.ts --publish      # also publishes a REAL test post per platform (see docs/SOCIAL-PLATFORM-APPROVALS.md)
 *   LIVE_REPORT=/path/report.md ... to also write the Markdown report to a file.
 *
 * Inputs (environment): see docs/SOCIAL-PLATFORM-APPROVALS.md, "Live verification runbook".
 */
import { writeFileSync } from 'fs';
import { createAdapters, redact, SocialApiError, type AdapterConfig, type AuthorizedAccount, type FetchLike, type Platform, type PlatformAdapter, type PublishableContent, type TokenSet } from '../src';

type Status = 'PASSED' | 'FAILED' | 'SKIPPED';
interface Row { platform: Platform; step: string; status: Status; detail: string }
const rows: Row[] = [];
const env = (k: string) => (process.env[k] ?? '').trim() || undefined;
const record = (platform: Platform, step: string, status: Status, detail: string) => { rows.push({ platform, step, status, detail: detail.replace(/\s+/g, ' ').slice(0, 400) }); };
const publish = process.argv.includes('--publish');

const fetchImpl: FetchLike = async (url, init) => {
  const res = await fetch(url, { method: init?.method, headers: init?.headers, body: init?.body as BodyInit | undefined, signal: init?.signal, redirect: init?.redirect });
  return { ok: res.ok, status: res.status, headers: { get: (n: string) => res.headers.get(n) }, text: () => res.text() };
};

const cfg: AdapterConfig = {
  metaAppId: env('META_APP_ID'), metaAppSecret: env('META_APP_SECRET'), metaGraphVersion: env('META_GRAPH_VERSION') ?? 'v21.0',
  tiktokClientKey: env('TIKTOK_CLIENT_KEY'), tiktokClientSecret: env('TIKTOK_CLIENT_SECRET'),
  googleClientId: env('GOOGLE_CLIENT_ID'), googleClientSecret: env('GOOGLE_CLIENT_SECRET'),
  linkedinClientId: env('LINKEDIN_CLIENT_ID'), linkedinClientSecret: env('LINKEDIN_CLIENT_SECRET'), linkedinApiVersion: env('LINKEDIN_API_VERSION') ?? '202411', linkedinOrgScopes: env('LINKEDIN_ORG_SCOPES') === 'true',
};
const adapters = createAdapters(cfg, fetchImpl);

const HOSTS: Record<Platform, string> = { FACEBOOK: 'https://graph.facebook.com/', INSTAGRAM: 'https://graph.facebook.com/', TIKTOK: 'https://open.tiktokapis.com/', YOUTUBE: 'https://www.googleapis.com/', LINKEDIN: 'https://api.linkedin.com/' };
const TOKEN_ENV: Record<Platform, string> = { FACEBOOK: 'LIVE_META_USER_TOKEN', INSTAGRAM: 'LIVE_META_USER_TOKEN', TIKTOK: 'LIVE_TIKTOK_ACCESS_TOKEN', YOUTUBE: 'LIVE_YOUTUBE_ACCESS_TOKEN', LINKEDIN: 'LIVE_LINKEDIN_ACCESS_TOKEN' };
const SCOPES_ENV: Record<Platform, string> = { FACEBOOK: '', INSTAGRAM: '', TIKTOK: 'LIVE_TIKTOK_SCOPES', YOUTUBE: 'LIVE_YOUTUBE_SCOPES', LINKEDIN: 'LIVE_LINKEDIN_SCOPES' };

async function reachable(url: string): Promise<boolean> {
  try {
    await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(8000) });
    return true;
  } catch {
    return false;
  }
}

const why = (e: unknown) => (e instanceof SocialApiError ? `${e.kind}${e.status ? ` HTTP ${e.status}` : ''}: ${e.message}` : redact(String((e as Error)?.message ?? e)));

async function step(platform: Platform, name: string, fn: () => Promise<string>) {
  try {
    record(platform, name, 'PASSED', await fn());
  } catch (e) {
    record(platform, name, 'FAILED', why(e));
  }
}

async function verify(platform: Platform) {
  const a: PlatformAdapter = adapters[platform];
  // 1. Server configuration (offline).
  const missing = a.missingConfiguration();
  if (missing.length) {
    record(platform, 'oauth.configuration', 'SKIPPED', `Missing server configuration: ${missing.join(', ')}`);
  } else {
    record(platform, 'oauth.configuration', 'PASSED', 'App credentials are present');
    // 2. The authorization URL TOUMA would send a person to (offline; proves the request is well formed, not that the platform accepts it).
    const u = new URL(a.buildAuthorizationUrl({ state: 'verify', redirectUri: env('LIVE_REDIRECT_URI') ?? 'https://example.invalid/callback' }).url);
    record(platform, 'oauth.authorize_url_built', u.searchParams.get('state') === 'verify' ? 'PASSED' : 'FAILED', `${u.host}${u.pathname}, scopes requested: ${(u.searchParams.get('scope') ?? '').replace(/,/g, ' ') || 'see adapter'}`);
  }
  const tokenValue = env(TOKEN_ENV[platform]);
  if (!tokenValue) return record(platform, 'oauth.token', 'SKIPPED', `No ${TOKEN_ENV[platform]} supplied: no authorized development account to test with. The OAuth round trip (consent screen, code exchange) needs a person; see the runbook.`);
  if (!(await reachable(HOSTS[platform]))) return record(platform, 'network', 'SKIPPED', `${new URL(HOSTS[platform]).host} is not reachable from this machine; run this from a machine with internet access.`);
  const scopes = (SCOPES_ENV[platform] ? env(SCOPES_ENV[platform]) ?? '' : '').split(/[ ,]+/).filter(Boolean);
  const tokens: TokenSet = { accessToken: tokenValue, refreshToken: env(`${TOKEN_ENV[platform]}_REFRESH`) ?? null, expiresAt: null, scopes };

  if (a.inspectToken) await step(platform, 'token.inspect', async () => { const i = await a.inspectToken!(tokens); if (!i.valid) throw new Error('The platform says the token is not valid'); return `valid, expires ${i.expiresAt?.toISOString() ?? 'never/unknown'}, scopes: ${(i.scopes ?? []).join(' ') || 'not reported'}`; });
  else record(platform, 'token.inspect', 'SKIPPED', 'This platform has no token introspection endpoint; validity is proven by the account listing.');

  let accounts: Awaited<ReturnType<PlatformAdapter['listAccounts']>> = [];
  await step(platform, 'accounts.list', async () => {
    accounts = await a.listAccounts(tokens);
    if (!accounts.length) throw new Error('The authorization lists no account that TOUMA can publish to');
    const trunc = accounts.some((x) => x.metadata?.listingTruncated);
    const missingPerms = [...new Set(accounts.flatMap((x) => x.permissionsMissing))];
    return `${accounts.length} account(s) [${[...new Set(accounts.map((x) => x.accountType))].join(', ')}]${trunc ? ' — LISTING TRUNCATED by the safety cap' : ''}; permissions missing: ${missingPerms.join(', ') || 'none'}`;
  });
  if (platform === 'LINKEDIN') {
    record(platform, 'permissions.personal_vs_organization', accounts.some((x) => x.accountType === 'PROFILE') ? 'PASSED' : 'FAILED', `personal profile: ${accounts.some((x) => x.accountType === 'PROFILE') ? 'listed' : 'absent'}; organizations listed: ${accounts.filter((x) => x.accountType === 'ORGANIZATION').length} (0 is expected until LinkedIn approves the Community Management API)`);
  }
  if (platform === 'TIKTOK' && a.requiredScopes.length) record(platform, 'permissions.scopes', scopes.length ? (a.requiredScopes.every((s) => scopes.includes(s)) ? 'PASSED' : 'FAILED') : 'SKIPPED', scopes.length ? `granted: ${scopes.join(' ')}` : 'Set LIVE_TIKTOK_SCOPES to the scopes the creator granted.');

  // 3. Publishing: only on explicit request, only to the account named for the test.
  const target = accounts.find((x) => x.externalAccountId === env('LIVE_ACCOUNT_ID')) ?? (env('LIVE_ACCOUNT_ID') ? undefined : accounts[0]);
  if (!publish) return record(platform, 'publish', 'SKIPPED', 'Run with --publish to publish one REAL test post (it will be visible on the development account).');
  if (!target) return record(platform, 'publish', 'SKIPPED', env('LIVE_ACCOUNT_ID') ? 'LIVE_ACCOUNT_ID names an account this authorization does not list.' : 'No account.');
  const imageUrl = env('LIVE_MEDIA_IMAGE_URL');
  const videoUrl = env('LIVE_MEDIA_VIDEO_URL');
  const text = `TOUMA integration test ${new Date().toISOString()}`;
  const auth: AuthorizedAccount = { externalAccountId: target.externalAccountId, accountType: target.accountType, parentExternalId: target.parentExternalId, tokens: target.tokens };
  const mk = (kind: 'IMAGE' | 'VIDEO'): PublishableContent => {
    const url = kind === 'IMAGE' ? imageUrl! : videoUrl!;
    return { kind, surface: kind === 'VIDEO' && platform === 'INSTAGRAM' ? 'REEL' : 'FEED', caption: text, hashtags: [], title: text, media: [{ id: 'live', url, mimeType: kind === 'IMAGE' ? 'image/jpeg' : 'video/mp4', sizeBytes: 0, read: async () => Buffer.from(await (await fetch(url)).arrayBuffer()) }] };
  };
  const kinds: Array<'IMAGE' | 'VIDEO'> = [];
  if (imageUrl && platform !== 'YOUTUBE') kinds.push('IMAGE');
  if (videoUrl) kinds.push('VIDEO');
  if (!kinds.length) return record(platform, 'publish', 'SKIPPED', 'Set LIVE_MEDIA_IMAGE_URL (public https JPEG) and/or LIVE_MEDIA_VIDEO_URL (public https MP4, H.264/AAC).');
  for (const kind of kinds) {
    const content = mk(kind);
    const issues = a.validate(content);
    if (issues.length) { record(platform, `publish.${kind.toLowerCase()}`, 'SKIPPED', `Rejected before sending by TOUMA validation: ${issues.map((i) => i.message).join(' ')}`); continue; }
    const startedAt = new Date();
    let id: string | null = null;
    await step(platform, `publish.${kind.toLowerCase()}`, async () => {
      let ref: { stage: string; ref: string } | null = null;
      for (let i = 0; i < 40; i++) {
        const out = await a.publish(auth, content, { idempotencyKey: `live-${Date.now()}`, resume: ref, checkpoint: async (stage, r) => { ref = { stage, ref: r }; }, beforeCreate: async () => undefined });
        if (out.status === 'PUBLISHED') { id = out.externalPostId; return `PUBLISHED by the platform: id ${out.externalPostId}, url ${out.url ?? 'none returned'}`; }
        ref = { stage: out.stage, ref: out.ref };
        await new Promise((r) => setTimeout(r, Math.max(out.retryAfterMs ?? 5000, 2000)));
        const st = await a.status(auth, out.ref, out.stage);
        if (st.status === 'PUBLISHED') { id = st.externalPostId; return `PUBLISHED by the platform after processing: id ${st.externalPostId}, url ${st.url ?? 'none returned (private/unaudited posts have no public link)'}`; }
        if (st.status === 'FAILED') throw new Error(`${st.code}: ${st.message}`);
      }
      throw new Error('The platform did not finish processing within the verification window');
    });
    if (id) {
      await step(platform, `reconcile.${kind.toLowerCase()}`, async () => {
        await new Promise((r) => setTimeout(r, 4000));
        const r = await a.reconcile(auth, { text, title: text, since: startedAt });
        if (r.result !== 'FOUND') throw new Error(`reconcile answered ${r.result}${'reason' in r ? `: ${r.reason}` : ''}`);
        return `the platform lists the post (id ${r.externalPostId})`;
      });
    }
  }
}

async function main() {
  for (const p of ['FACEBOOK', 'INSTAGRAM', 'TIKTOK', 'YOUTUBE', 'LINKEDIN'] as Platform[]) {
    try { await verify(p); } catch (e) { record(p, 'unexpected', 'FAILED', why(e)); }
  }
  const count = (s: Status) => rows.filter((r) => r.status === s).length;
  const md = [
    `# TOUMA live verification — ${new Date().toISOString()}`, '',
    `Mode: ${publish ? 'read + REAL test publishing' : 'read-only'} · PASSED ${count('PASSED')} · FAILED ${count('FAILED')} · SKIPPED ${count('SKIPPED')}`, '',
    'A SKIPPED step was not tested. Only PASSED steps with a platform-issued id or response are evidence of real behavior.', '',
    '| Platform | Step | Status | Detail |', '|---|---|---|---|', ...rows.map((r) => `| ${r.platform} | ${r.step} | ${r.status} | ${r.detail.replace(/\|/g, '\\|')} |`), '',
  ].join('\n');
  console.log(md);
  if (env('LIVE_REPORT')) writeFileSync(env('LIVE_REPORT')!, md);
  process.exitCode = count('FAILED') ? 1 : 0;
}
void main();
