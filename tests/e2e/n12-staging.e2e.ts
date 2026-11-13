import { execSync } from 'child_process';
import { expect, test, type Browser, type Page } from '@playwright/test';

/**
 * Phase N12: real browser validation across the newer modules (Chromium, real API + Next.js + PostgreSQL + Redis, simulated
 * providers only). Setup that has no UI (promoting a platform admin, adding a member, defining the calendar workflow) uses SQL
 * or the API and is marked as such in each scenario.
 */
const PASSWORD = 'Correct-Horse-9-Battery';
const DB = (process.env.TEST_DATABASE_URL ?? 'postgresql://touma:touma_dev_password@localhost:5432/touma_test').split('?')[0]!;
const sql = (q: string) => execSync(`psql -v ON_ERROR_STOP=1 "${DB}" -At`, { input: q }).toString().trim();
const uid = () => `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
test.use({ timezoneId: 'Africa/Ndjamena' });

async function signUp(page: Page, business: string | null) {
  const email = `n12-${uid()}@example.com`;
  await page.goto('/register');
  await page.getByLabel('Full name').fill('Awa Mahamat');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  if (business) {
    await page.getByLabel('Business name').fill(business);
    await page.getByLabel('Business type').selectOption('RESTAURANT');
    await page.getByLabel('Currency').selectOption('XAF');
    await page.getByRole('button', { name: 'Create my business' }).click();
    await expect(page).toHaveURL(/\/dashboard$/);
  }
  return email;
}
async function signIn(page: Page, email: string) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/(dashboard|onboarding)/);
}
/** An authenticated API call made by the page itself (cookie refresh then bearer), like the app does. */
async function api(page: Page, path: string, init: { method?: string; body?: unknown; businessId?: string; headers?: Record<string, string> } = {}) {
  // One refresh per page, then the access token is reused until the API answers 401: rotating the refresh cookie on every call
  // would race with the app's own refreshes.
  return page.evaluate(async ({ path, init }) => {
    const w = window as unknown as { __n12?: string };
    const call = async (token: string) => {
      const res = await fetch(path, { method: init.method ?? 'GET', headers: { authorization: `Bearer ${token}`, ...(init.businessId ? { 'x-business-id': init.businessId } : {}), ...(init.body ? { 'content-type': 'application/json' } : {}), ...(init.headers ?? {}) }, body: init.body ? JSON.stringify(init.body) : undefined });
      return { status: res.status, body: await res.json().catch(() => null) };
    };
    if (w.__n12) {
      const r = await call(w.__n12);
      if (r.status !== 401) return r;
    }
    for (let i = 0; i < 12; i++) {
      const r = await fetch('/api/v1/auth/refresh', { method: 'POST', headers: { 'x-touma-csrf': '1' } });
      if (r.ok) {
        w.__n12 = (await r.json()).accessToken as string;
        return call(w.__n12);
      }
      await new Promise((r2) => setTimeout(r2, 400));
    }
    throw new Error('no session');
  }, { path: `/api/v1${path}`, init });
}
const bizId = async (page: Page) => ((await api(page, '/businesses')).body as Array<{ id: string }>)[0]!.id;
const newPage = async (browser: Browser) => (await browser.newContext({ timezoneId: 'Africa/Ndjamena' })).newPage();
const day = (n: number) => new Date(Date.now() + 3_600_000 + n * 86_400_000).toISOString().slice(0, 10);

test('auth: invalid credentials, protected routes, logout, revoked session', async ({ page }) => {
  for (const path of ['/dashboard', '/dashboard/workflows', '/dashboard/operations', '/dashboard/calendar']) {
    await page.goto(path);
    await expect(page).toHaveURL(/\/login$/);
  }
  await page.getByLabel('Email').fill('nobody@example.com');
  await page.getByLabel('Password').fill('Wrong-password-1');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByTestId('form-error')).toHaveText('Invalid email or password.');

  const email = await signUp(page, 'Auth Shop');
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.goto('/dashboard/workflows');
  await expect(page).toHaveURL(/\/login$/);
  await signIn(page, email);
  await page.goto('/dashboard/workflows');
  await expect(page.getByRole('heading', { name: 'Workflows' })).toBeVisible();

  // Session expiry: the server revokes every session of the user; the next navigation must end at the login page.
  sql(`update "Session" set "revokedAt" = now() where "userId" = (select id from "User" where email = '${email}')`);
  await page.context().clearCookies({ name: 'touma_at' }).catch(() => undefined);
  await page.reload();
  await expect(page).toHaveURL(/\/login$/);
});

test('roles: viewer is read-restricted, tenant owner cannot open administration, platform admin can', async ({ page, browser }) => {
  const ownerEmail = await signUp(page, 'Roles Shop');
  const business = await bizId(page);
  // The viewer: a second account added to the business by SQL (no member UI path in this scenario).
  const vp = await newPage(browser);
  const viewerEmail = await signUp(vp, null);
  sql(`insert into "Membership" (id, "userId", "businessId", role, status, "createdAt", "updatedAt") select 'n12m' || substr(md5(random()::text),1,16), u.id, '${business}', 'VIEWER', 'ACTIVE', now(), now() from "User" u where u.email = '${viewerEmail}'`);
  await signIn(vp, viewerEmail);
  await expect(vp).toHaveURL(/\/dashboard$/); // the viewer has a membership: wait for the dashboard, not the onboarding redirect
  await vp.goto('/dashboard/workflows');
  await expect(vp.getByText('Something went wrong')).toBeVisible({ timeout: 10_000 }); // viewers hold no workflow permission: the API refuses and the page says so
  await expect(vp.getByRole('button', { name: 'Create the demo workflow' })).toHaveCount(0);
  await expect(vp.getByRole('link', { name: 'Operations' })).toHaveCount(0);
  await vp.goto('/dashboard/operations');
  await expect(vp.getByTestId('ops-forbidden')).toBeVisible();

  await page.goto('/dashboard/operations');
  await expect(page.getByTestId('ops-forbidden')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Operations' })).toHaveCount(0);
  expect((await api(page, '/admin/ops/overview')).status).toBe(403);

  // Platform administrator (promoted in the database; there is no UI for that).
  sql(`update "User" set "platformRole" = 'SUPER_ADMIN' where email = '${ownerEmail}'`);
  await page.getByRole('button', { name: 'Sign out' }).click();
  await signIn(page, ownerEmail);
  await page.getByRole('link', { name: 'Operations' }).click();
  await expect(page.getByTestId('ops-view')).toBeVisible();
  await expect(page.getByTestId('ops-source')).toContainText('Measured live');
  await page.getByTestId('ops-collect').click();
  await expect(page.locator('[data-testid="ops-queue"][data-source="measured"]')).toHaveCount(5);
  await expect(page.locator('[data-testid="ops-tile"][data-tile="database"]')).toContainText('Up');
  await page.getByTestId('ops-threshold').fill('7');
  await page.getByTestId('ops-save-rule').click();
  await expect(page.getByTestId('ops-rule')).toContainText('at least 7 failed jobs');
});

test('tenant isolation in the browser: workflows, calendar and conversations of another business are invisible and unreachable', async ({ page, browser, request }) => {
  await signUp(page, 'Tenant A');
  const a = await bizId(page);
  await page.goto('/dashboard/workflows');
  await page.getByRole('button', { name: 'Create the demo workflow' }).click();
  await expect(page.getByTestId('workflow-card')).toHaveCount(1);
  const wf = sql(`select id from "WorkflowDefinition" where "businessId" = '${a}' limit 1`);
  await api(page, `/workflows/${wf}/activate`, { method: 'POST', businessId: a, body: {} });
  const run = (await api(page, `/workflows/${wf}/executions`, { method: 'POST', businessId: a, body: { input: { topic: 'A secret launch' } }, headers: { 'idempotency-key': `n12-iso-${uid()}-key` } })).body.id as string;
  const entry = (await api(page, '/calendar/entries', { method: 'POST', businessId: a, body: { title: 'A private post', platform: 'INSTAGRAM', localDate: day(4), localTime: '10:00' } })).body.id as string;
  await api(page, '/sales/agent', { method: 'PUT', businessId: a, body: { enabled: true, replyMode: 'AUTO', languages: ['en'], defaultLanguage: 'en' } });
  const slug = sql(`select slug from "Business" where id = '${a}'`);
  const chat = await request.post(`/api/v1/public/chat/${slug}/messages`, { data: { message: 'Tenant A confidential question' } });
  expect(chat.status()).toBe(200);
  const conv = sql(`select id from "Conversation" where "businessId" = '${a}' limit 1`);

  const b = await newPage(browser);
  await signUp(b, 'Tenant B');
  const bid = await bizId(b);
  await b.goto('/dashboard/workflows');
  await expect(b.getByText('No workflow yet.')).toBeVisible();
  await b.goto(`/dashboard/calendar/month?date=${day(4)}`);
  await expect(b.locator('[data-testid="calendar-entry"]', { hasText: 'A private post' })).toHaveCount(0);
  await b.goto('/dashboard/sales');
  await expect(b.getByText('Tenant A confidential question')).toHaveCount(0);
  // Direct requests with B's session against A's identifiers: every one is a plain 404 (never 403, never data).
  for (const [method, path] of [['GET', `/runs/${run}`], ['POST', `/runs/${run}/steps/calendar_schedule/approve`], ['POST', `/runs/${run}/cancel`], ['GET', `/calendar/entries/${entry}`], ['POST', `/calendar/entries/${entry}/cancel`], ['GET', `/sales/conversations/${conv}`], ['POST', `/sales/conversations/${conv}/takeover`], ['POST', `/workflows/${wf}/activate`]] as const) {
    const r = await api(b, path, { method, businessId: bid, body: method === 'POST' ? {} : undefined });
    expect([path, r.status]).toEqual([path, 404]);
  }
  // Naming A's business in the header does not help either.
  expect((await api(b, `/runs/${run}`, { businessId: a })).status).toBe(404);
});

test('workflow end to end: demo in the UI, then an approved step that creates a real calendar entry', async ({ page }) => {
  await signUp(page, 'Flow Shop');
  const biz = await bizId(page);
  // 1. Fully in the browser: the demo workflow (its calendar step is a simulation).
  await page.goto('/dashboard/workflows');
  await expect(page.getByText('No workflow yet.')).toBeVisible();
  await page.getByRole('button', { name: 'Create the demo workflow' }).click();
  const card = page.getByTestId('workflow-card').first();
  await card.getByRole('button', { name: 'Activate' }).click();
  await expect(card.getByText('Active', { exact: true })).toBeVisible();
  await card.getByLabel('Topic').fill('Autumn collection');
  await card.getByRole('button', { name: 'Start' }).click();
  const exec = card.getByTestId('execution').first();
  await expect(exec).toContainText('Waiting for approval');
  await expect(exec.getByText('Waiting for a person to approve')).toBeVisible();
  await exec.getByRole('button', { name: 'Approve' }).click();
  await expect.poll(() => sql(`select status from "AgentRun" where "businessId" = '${biz}' and input->>'topic' = 'Autumn collection'`), { timeout: 15_000 }).toBe('COMPLETED');

  // 2. The calendar step: the UI can neither define nor start a workflow with the calendar adapter (its start form only has "Topic"),
  //    so the definition and the start use the API; the approval and the result are checked in the browser.
  const def = { triggers: [{ type: 'manual' }], input: { title: { type: 'string', required: true, maxLength: 200 }, platform: { type: 'string', required: true, maxLength: 30 }, scheduled_at: { type: 'string', required: true, maxLength: 40 } }, steps: [{ key: 'draft', adapter: 'simulated.content-draft' }, { key: 'calendar_entry', adapter: 'calendar.create-entry', dependsOn: ['draft'], requiresApproval: true }] };
  const wf = (await api(page, '/workflows', { method: 'POST', businessId: biz, body: { name: 'Calendar plan', definition: def } })).body.id as string;
  await api(page, `/workflows/${wf}/activate`, { method: 'POST', businessId: biz, body: {} });
  const when = new Date(Date.now() + 3 * 86_400_000 + 3_600_000).toISOString();
  const started = await api(page, `/workflows/${wf}/executions`, { method: 'POST', businessId: biz, body: { input: { title: 'Workflow planned post', platform: 'INSTAGRAM', scheduled_at: when } }, headers: { 'idempotency-key': `n12-cal-${uid()}-key` } });
  expect(started.status).toBe(201);
  await page.goto('/dashboard/workflows');
  const plan = page.locator('[data-testid="workflow-card"]', { hasText: 'Calendar plan' }).first();
  await plan.getByRole('button', { name: 'Executions' }).click();
  const run = plan.getByTestId('execution').first();
  await expect(run).toContainText('Waiting for approval');
  expect(sql(`select count(*) from "CalendarEvent" where "businessId" = '${biz}'`)).toBe('0'); // not approved yet: no event
  await run.getByRole('button', { name: 'Approve' }).click();
  // (the word "Completed" also appears for the first steps: wait for the run itself, in the database and then in the page)
  await expect.poll(() => sql(`select status from "AgentRun" where "businessId" = '${biz}' and "workflowId" = '${wf}'`), { timeout: 15_000 }).toBe('COMPLETED');
  expect(sql(`select count(*) from "CalendarEvent" where "businessId" = '${biz}' and title = 'Workflow planned post'`)).toBe('1');
  const localDay = new Date(new Date(when).getTime() + 3_600_000).toISOString().slice(0, 10);
  await page.goto(`/dashboard/calendar/month?date=${localDay}`);
  await expect(page.locator('[data-testid="calendar-entry"]:visible', { hasText: 'Workflow planned post' })).toHaveCount(1);
});

test('other modules load with real data or an honest empty state, and the layout works on a phone', async ({ page }) => {
  await signUp(page, 'Modules Shop');
  const pages: Array<[string, RegExp]> = [['/dashboard/market', /Market intelligence/], ['/dashboard/sales', /AI conversations/], ['/dashboard/creative', /Creative Studio/], ['/dashboard/social', /Social media/], ['/dashboard/calendar', /Content calendar/], ['/dashboard/workflows', /Workflows/]];
  for (const [path, heading] of pages) {
    await page.goto(path);
    await expect(page.getByRole('heading', { name: heading }).first()).toBeVisible();
    await expect(page.getByText('Application error')).toHaveCount(0);
  }
  await page.goto('/dashboard/market');
  await expect(page.getByText('No researched product yet.')).toBeVisible();
  await expect(page.getByText(/Nothing is looked up, scraped or estimated/)).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/dashboard/workflows');
  await page.getByRole('button', { name: 'Menu' }).click();
  await expect(page.getByRole('dialog', { name: 'Menu' })).toBeVisible();
  await page.getByRole('dialog', { name: 'Menu' }).getByRole('link', { name: 'Market intelligence' }).click();
  await expect(page).toHaveURL(/\/dashboard\/market$/);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1); // no horizontal scroll on a phone
});

test('error handling: network failure, API error, loading, empty state, invalid input, duplicate submission', async ({ page }) => {
  await signUp(page, 'Errors Shop');
  const errBiz = await bizId(page);
  // Network failure, then recovery through Retry.
  await page.route('**/api/v1/workflows?**', (r) => r.abort());
  await page.goto('/dashboard/workflows');
  await expect(page.getByText('Something went wrong')).toBeVisible();
  await page.unroute('**/api/v1/workflows?**');
  await page.getByRole('button', { name: 'Retry' }).click();
  await expect(page.getByText('No workflow yet.')).toBeVisible(); // empty state
  // API error (500).
  await page.route('**/api/v1/workflows?**', (r) => r.fulfill({ status: 500, contentType: 'application/json', body: '{"statusCode":500,"code":"INTERNAL_SERVER_ERROR","message":"x"}' }));
  await page.reload();
  await expect(page.getByText('Something went wrong')).toBeVisible();
  await page.unroute('**/api/v1/workflows?**');
  // Loading state while the API is slow.
  await page.route('**/api/v1/workflows?**', async (r) => { await new Promise((res) => setTimeout(res, 1500)); await r.continue(); });
  await page.reload();
  await expect(page.getByRole('status', { name: 'Loading…' })).toBeVisible();
  await expect(page.getByText('No workflow yet.')).toBeVisible();
  await page.unroute('**/api/v1/workflows?**');
  // Invalid input: the start button stays disabled without a topic.
  await page.getByRole('button', { name: 'Create the demo workflow' }).click();
  const card = page.getByTestId('workflow-card').first();
  await card.getByRole('button', { name: 'Activate' }).click();
  await expect(card.getByRole('button', { name: 'Start' })).toBeDisabled();
  // Duplicate submission: two fast clicks start one execution only.
  await card.getByLabel('Topic').fill('Double click');
  const start = card.getByRole('button', { name: 'Start' });
  await start.dblclick();
  await expect(card.getByTestId('execution')).toHaveCount(1);
  await page.waitForTimeout(800);
  expect(sql(`select count(*) from "AgentRun" where "businessId" = '${errBiz}' and input->>'topic' = 'Double click'`)).toBe('1');
});
