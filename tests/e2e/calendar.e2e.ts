import { expect, test, type Page } from '@playwright/test';

/**
 * Full-stack content calendar flows: entries, drag and drop, conflicts, the approval workflow, the 30-day AI planner
 * (test-only deterministic AI provider), recurring schedules, notifications and phone layouts. Nothing is published:
 * there is no publisher yet and the UI says so.
 */
test.use({ timezoneId: 'Africa/Ndjamena' }); // UTC+1: the business timezone is taken from the browser at onboarding

/** A local date (business timezone, UTC+1) n days from today. */
const day = (n: number) => new Date(Date.now() + 3_600_000 + n * 86_400_000).toISOString().slice(0, 10);

async function setup(page: Page) {
  await page.goto('/register');
  await page.getByLabel('Full name').fill('Awa Mahamat');
  await page.getByLabel('Email').fill(`cal${Date.now()}${Math.floor(Math.random() * 1e6)}@example.com`);
  await page.getByLabel('Password').fill('Correct-Horse-9-Battery');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByLabel('Business name').fill('Maquis Awa');
  await page.getByLabel('Business type').selectOption('RESTAURANT');
  await page.getByLabel('Currency').selectOption('XAF');
  await page.getByRole('button', { name: 'Create my business' }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await page.evaluate(async () => {
    const call = async (path: string, init?: { method: string; body: unknown; businessId: string }) => {
      for (let i = 0; i < 8; i++) {
        const refreshed = await fetch('/api/v1/auth/refresh', { method: 'POST', headers: { 'x-touma-csrf': '1' } });
        if (refreshed.ok) {
          const { accessToken } = await refreshed.json();
          const res = await fetch(path, {
            method: init?.method ?? 'GET',
            headers: { authorization: `Bearer ${accessToken}`, ...(init ? { 'x-business-id': init.businessId, 'content-type': 'application/json' } : {}) },
            body: init ? JSON.stringify(init.body) : undefined,
          });
          if (res.ok) return res.json();
        }
        await new Promise((r) => setTimeout(r, 250));
      }
      throw new Error(`could not call ${path}`);
    };
    const biz = (await call('/api/v1/businesses'))[0] as { id: string };
    await call('/api/v1/products', { method: 'POST', businessId: biz.id, body: { name: 'Bissap juice', price: '1500', status: 'ACTIVE', features: ['Hibiscus flowers'], benefits: ['Refreshing'] } });
  });
}

/** Opens the "plan a post" dialog on the month view of a date and creates an entry. */
async function createEntry(page: Page, p: { title: string; date: string; time: string; platform?: string; caption?: string }) {
  await page.goto(`/dashboard/calendar/month?date=${p.date}`);
  await page.getByTestId('new-entry').click();
  const form = page.getByTestId('new-entry-form');
  await form.getByLabel('Title').fill(p.title);
  if (p.platform) await form.getByLabel('Platform').selectOption(p.platform);
  await form.getByLabel('Date').fill(p.date);
  await form.getByLabel('Time').fill(p.time);
  if (p.caption) await form.getByLabel('Caption').fill(p.caption);
  await form.getByTestId('ne-submit').click();
}

const entry = (page: Page, title: string) => page.locator('[data-testid="calendar-entry"]:visible', { hasText: title });

test('overview shows the calendar status and tabs', async ({ page }) => {
  await setup(page);
  await page.getByRole('navigation', { name: 'Menu' }).getByRole('link', { name: 'Calendar' }).click();
  await expect(page).toHaveURL(/\/dashboard\/calendar$/);
  await expect(page.getByTestId('calendar-timezone')).toHaveText('Africa/Ndjamena');
  await expect(page.getByTestId('stat-pending')).toHaveText('0');
  await expect(page.getByTestId('publishing-unavailable')).toHaveCount(0); // the platform simulator is configured in this environment
  await expect(page.getByRole('navigation', { name: 'Content calendar' }).getByRole('link')).toHaveCount(6);
  await expect(page.getByTestId('calendar-legend')).toContainText('Pending approval');
});

test('plan a post, get it approved and authorized, with its history', async ({ page }) => {
  await setup(page);
  const date = day(4);
  await createEntry(page, { title: 'Bissap weekend', date, time: '10:00', caption: 'Fresh bissap juice, served cold.' });
  await expect(entry(page, 'Bissap weekend')).toBeVisible();
  await entry(page, 'Bissap weekend').click();
  const dialog = page.getByTestId('entry-dialog');
  await expect(dialog).toHaveAttribute('data-status', 'DRAFT');
  await expect(dialog.getByTestId('entry-time-source')).toHaveAttribute('data-source', 'MANUAL');
  await dialog.getByTestId('act-submit').click();
  await expect(dialog).toHaveAttribute('data-status', 'IN_REVIEW');
  await expect(dialog.getByTestId('act-authorize')).toHaveCount(0); // not approved yet
  await dialog.getByTestId('act-approve').click();
  await expect(dialog).toHaveAttribute('data-status', 'APPROVED');
  // Scheduling is the explicit authorization: it needs an explicit confirmation.
  await expect(dialog.getByTestId('act-authorize')).toBeDisabled();
  await dialog.getByTestId('authorize-check').check();
  await dialog.getByTestId('act-authorize').click();
  await expect(dialog).toHaveAttribute('data-status', 'SCHEDULED');
  await expect(dialog.getByTestId('entry-no-publisher')).toHaveCount(0);
  await expect(dialog.getByTestId('entry-history').locator('li')).toHaveCount(3);
  await expect(dialog.getByTestId('entry-history')).toContainText('Authorized to publish');
  // Editing the text withdraws approval and authorization.
  await dialog.getByLabel('Caption').fill('A different caption');
  await dialog.getByTestId('entry-save').click();
  await expect(dialog).toHaveAttribute('data-status', 'DRAFT');
  await expect(dialog.getByTestId('entry-history')).toContainText('Withdrawn');
});

test('drag and drop moves an entry to another day and keeps it after a reload', async ({ page }) => {
  await setup(page);
  const from = day(5);
  const to = day(6);
  await createEntry(page, { title: 'Move me', date: from, time: '12:00' });
  await expect(entry(page, 'Move me')).toBeVisible();
  const target = page.locator(`[data-testid="day-cell"][data-date="${to}"]:visible`);
  await entry(page, 'Move me').dragTo(target);
  await expect(page.getByTestId('calendar-notice')).toContainText('Moved “Move me”');
  await expect(target.getByTestId('calendar-entry')).toContainText('Move me');
  await expect(target.getByTestId('calendar-entry')).toContainText('12:00'); // local time is kept
  await page.reload();
  await expect(page.locator(`[data-testid="day-cell"][data-date="${to}"]:visible`).getByTestId('calendar-entry')).toContainText('Move me');
});

test('day view: drag an entry to another hour', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1400 }); // both hours must be on screen for a drag
  await setup(page);
  const date = day(5);
  await createEntry(page, { title: 'Hourly', date, time: '09:00' });
  await page.goto(`/dashboard/calendar/day?date=${date}`);
  await expect(page.getByTestId('calendar-title')).toBeVisible();
  const chip = page.locator('[data-testid="calendar-entry"]', { hasText: 'Hourly' });
  await chip.dragTo(page.locator('[data-testid="hour-row"][data-hour="11"]'));
  await expect(page.locator('[data-testid="hour-row"][data-hour="11"]').getByTestId('calendar-entry')).toContainText('11:00');
});

test('conflicts must be confirmed, and platform views filter the calendar', async ({ page }) => {
  await setup(page);
  const date = day(7);
  await createEntry(page, { title: 'First post', date, time: '12:00', platform: 'INSTAGRAM' });
  await expect(entry(page, 'First post')).toBeVisible();
  await page.getByTestId('new-entry').click();
  const form = page.getByTestId('new-entry-form');
  await form.getByLabel('Title').fill('Second post');
  await form.getByLabel('Platform').selectOption('INSTAGRAM');
  await form.getByLabel('Date').fill(date);
  await form.getByLabel('Time').fill('13:00');
  await form.getByTestId('ne-submit').click();
  const conflict = page.getByTestId('conflict-list');
  await expect(conflict).toContainText('Too close to another post');
  await page.getByTestId('conflict-confirm').click();
  await expect(entry(page, 'Second post')).toBeVisible();
  // Another platform at the same time is not a conflict.
  await page.getByTestId('new-entry').click();
  await form.getByLabel('Title').fill('Facebook post');
  await form.getByLabel('Platform').selectOption('FACEBOOK');
  await form.getByLabel('Date').fill(date);
  await form.getByLabel('Time').fill('12:00');
  await form.getByTestId('ne-submit').click();
  await expect(entry(page, 'Facebook post')).toBeVisible();
  await expect(page.getByTestId('conflict-list')).toHaveCount(0);
  // Platform-specific view.
  await page.getByLabel('Platform').first().selectOption('FACEBOOK');
  await expect(entry(page, 'Facebook post')).toBeVisible();
  await expect(entry(page, 'First post')).toHaveCount(0);
});

test('the new-entry dialog recommends times and labels them as estimates', async ({ page }) => {
  await setup(page);
  await page.goto(`/dashboard/calendar/month?date=${day(9)}`);
  await page.getByTestId('new-entry').click();
  const rec = page.getByTestId('recommendation');
  await expect(rec).toHaveAttribute('data-source', 'ESTIMATE');
  await expect(rec).toContainText('not your audience data');
  await rec.getByRole('button').first().click();
  await expect(page.getByTestId('new-entry-form').getByLabel('Time')).not.toHaveValue('');
});

test('week view lists the seven days and day cells accept new entries', async ({ page }) => {
  await setup(page);
  const date = day(3);
  await createEntry(page, { title: 'Week post', date, time: '18:00' });
  await page.goto(`/dashboard/calendar/week?date=${date}`);
  await expect(page.getByTestId('week-grid').getByTestId('day-cell')).toHaveCount(7);
  await expect(entry(page, 'Week post')).toBeVisible();
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(entry(page, 'Week post')).toHaveCount(0);
  await page.getByRole('button', { name: 'Today' }).click();
});

test('approvals page: approve and reject with a reason, with the decisions recorded', async ({ page }) => {
  await setup(page);
  await createEntry(page, { title: 'Needs review A', date: day(3), time: '09:00', caption: 'Fresh bissap juice, served cold.' });
  await createEntry(page, { title: 'Needs review B', date: day(3), time: '19:00', caption: 'Our grilled chicken is ready.' });
  for (const title of ['Needs review A', 'Needs review B']) {
    await page.goto(`/dashboard/calendar/month?date=${day(3)}`);
    await entry(page, title).click();
    await page.getByTestId('act-submit').click();
    await expect(page.getByTestId('entry-dialog')).toHaveAttribute('data-status', 'IN_REVIEW');
  }
  await page.goto('/dashboard/calendar/approvals');
  await expect(page.getByTestId('pending-count')).toHaveText('2');
  const a = page.locator('[data-testid="approval-item"]', { hasText: 'Needs review A' });
  await a.getByTestId('quick-approve').click();
  await expect(page.getByTestId('ready-list')).toContainText('Needs review A');
  const b = page.locator('[data-testid="approval-item"]', { hasText: 'Needs review B' });
  await b.getByTestId('quick-reject').click();
  await page.getByLabel('Reason (shown to the author)').fill('Please mention opening hours');
  await page.getByTestId('quick-reject-confirm').click();
  await expect(page.getByTestId('pending-list')).toHaveCount(0);
  await expect(page.getByTestId('decision-list')).toContainText('Approved');
  await expect(page.getByTestId('decision-list')).toContainText('Rejected');
  await expect(page.getByTestId('decision-list')).toContainText('Please mention opening hours');
});

test('notifications: approvers are told about content awaiting approval', async ({ page }) => {
  await setup(page);
  await createEntry(page, { title: 'Notify me', date: day(3), time: '09:00', caption: 'Fresh bissap juice, served cold.' });
  await entry(page, 'Notify me').click();
  await page.getByTestId('act-submit').click();
  await expect(page.getByTestId('entry-dialog')).toHaveAttribute('data-status', 'IN_REVIEW');
  await page.keyboard.press('Escape');
  await page.reload();
  await expect(page.getByTestId('notification-count')).toHaveText('1');
  await page.getByTestId('notification-bell').click();
  await expect(page.getByTestId('notification-item')).toContainText('Approval needed: Notify me');
  await page.getByTestId('notification-read-all').click();
  await expect(page.getByTestId('notification-count')).toHaveCount(0);
});

test('30-day planner: generate, review, add to the calendar as drafts, once', async ({ page }) => {
  await setup(page);
  await page.goto('/dashboard/calendar/planner');
  const start = day(2);
  await page.getByLabel('First day').fill(start);
  await page.getByLabel('Occasion name').fill('Opening anniversary');
  await page.getByLabel('Date', { exact: true }).last().fill(day(12));
  await page.getByRole('button', { name: 'Add occasion' }).click();
  await expect(page.getByTestId('occasion-list')).toContainText('Opening anniversary');
  await page.getByTestId('planner-generate').click();
  const preview = page.getByTestId('plan-preview');
  await expect(preview).toBeVisible({ timeout: 45_000 });
  await expect(page.getByTestId('plan-time-note')).toContainText('estimates');
  await expect(page.getByTestId('plan-balance')).toContainText('Product showcase');
  expect(await page.locator('[data-testid="plan-item"]').count()).toBeGreaterThan(15);
  // Seasonal posts exist only for the occasion we supplied.
  await expect(page.locator('[data-testid="plan-item"][data-pillar="SEASONAL"]')).toHaveCount(1);
  await expect(page.locator('[data-testid="plan-item"][data-pillar="SEASONAL"]')).toContainText('Opening anniversary');
  await expect(preview).toContainText('Estimate');
  await page.getByTestId('plan-apply').click();
  await expect(page.getByTestId('plan-applied')).toContainText('Plan added to the calendar');
  await expect(page.getByTestId('plan-apply')).toHaveCount(0); // once
  await page.getByRole('link', { name: 'Open the calendar' }).click();
  await expect(page.locator('[data-testid="calendar-entry"][data-status="DRAFT"]:visible').first()).toBeVisible();
  // Nothing was approved or scheduled by the plan.
  await expect(page.locator('[data-testid="calendar-entry"][data-status="SCHEDULED"]')).toHaveCount(0);
  await page.goto('/dashboard/calendar');
  await expect(page.getByTestId('pillar-balance')).toBeVisible();
});

test('recurring schedule: create entries at one local time and stop the schedule', async ({ page }) => {
  await setup(page);
  await page.goto('/dashboard/calendar/planner');
  const form = page.getByTestId('recurrence-form');
  await form.getByLabel('Title').fill('Weekly tip');
  await form.getByLabel('Platform').selectOption('TIKTOK');
  await form.getByLabel('From').fill(day(2));
  await form.getByLabel('Until').fill(day(30));
  await form.getByTestId('recurrence-create').click();
  await expect(page.getByTestId('recurrence-done')).toContainText('entries created');
  await expect(page.getByTestId('recurrence-list')).toContainText('Weekly tip');
  await page.getByRole('button', { name: 'Stop' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Stop' }).click();
  await expect(page.getByTestId('recurrence-list')).toHaveCount(0);
});

test.describe('mobile (390×844)', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('every calendar page fits the screen without horizontal scrolling', async ({ page }) => {
    await setup(page);
    await createEntry(page, { title: 'Phone post with a rather long title to test wrapping', date: day(3), time: '10:00' });
    for (const p of ['', '/month', '/week', '/day', '/planner', '/approvals']) {
      await page.goto(`/dashboard/calendar${p}${['/month', '/week', '/day'].includes(p) ? `?date=${day(3)}` : ''}`);
      await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
      await page.waitForLoadState('networkidle');
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, `horizontal overflow on /dashboard/calendar${p}`).toBeLessThanOrEqual(1);
    }
  });

  test('the month shows dots, a tap opens the day agenda, and an entry can be opened and edited', async ({ page }) => {
    await setup(page);
    const date = day(3);
    await createEntry(page, { title: 'Tap me', date, time: '10:00', caption: 'Fresh bissap juice, served cold.' });
    await expect(page.getByTestId('month-compact')).toBeVisible();
    await page.getByTestId('month-compact').getByRole('button', { name: new RegExp(`1 entr`) }).first().click();
    await expect(page.getByTestId('day-agenda')).toBeVisible();
    await page.locator('[data-testid="day-agenda"] [data-testid="calendar-entry"]', { hasText: 'Tap me' }).click();
    const dialog = page.getByTestId('entry-dialog');
    await expect(dialog).toBeVisible();
    const box = await dialog.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(390 + 1);
    await dialog.getByTestId('act-submit').click();
    await expect(dialog).toHaveAttribute('data-status', 'IN_REVIEW');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  });

  test('creating an entry and generating a plan are usable on a phone', async ({ page }) => {
    await setup(page);
    await page.goto(`/dashboard/calendar/month?date=${day(3)}`);
    await page.getByTestId('new-entry').click();
    const form = page.getByTestId('new-entry-form');
    await form.getByLabel('Title').fill('From my phone');
    await form.getByLabel('Date').fill(day(3));
    await form.getByLabel('Time').fill('11:00');
    await form.getByTestId('ne-submit').scrollIntoViewIfNeeded();
    const btn = await form.getByTestId('ne-submit').boundingBox();
    expect(btn!.height).toBeGreaterThanOrEqual(36);
    await form.getByTestId('ne-submit').click();
    await expect(page.getByTestId('day-agenda').or(page.getByTestId('month-compact'))).toBeVisible();
    await page.goto('/dashboard/calendar/planner');
    await page.getByLabel('First day').fill(day(2));
    await page.getByTestId('planner-generate').click();
    await expect(page.getByTestId('plan-preview')).toBeVisible({ timeout: 45_000 });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  });
});
