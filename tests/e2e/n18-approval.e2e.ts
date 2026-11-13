import { expect, test, type Page } from '@playwright/test';

/**
 * Phase N18, Approval Center in a real browser (Chromium, phone size): a post written by an editor is reviewed, approved after an
 * explicit confirmation, authorized, then edited: the edit sends it back to pending approval. The platform is the test-only
 * simulator; nothing is posted anywhere.
 */
test.use({ timezoneId: 'Africa/Ndjamena', viewport: { width: 390, height: 844 } });

async function setup(page: Page) {
  await page.goto('/register');
  await page.getByLabel('Full name').fill('Awa Mahamat');
  await page.getByLabel('Email').fill(`n18${Date.now()}${Math.floor(Math.random() * 1e6)}@example.com`);
  await page.getByLabel('Password').fill('Correct-Horse-9-Battery');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByLabel('Business name').fill('Maquis Awa');
  await page.getByLabel('Business type').selectOption('RESTAURANT');
  await page.getByLabel('Currency').selectOption('XAF');
  await page.getByRole('button', { name: 'Create my business' }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
}
async function api(page: Page, path: string, init: { method?: string; body?: unknown } = {}) {
  return page.evaluate(async ({ path, init }) => {
    const biz = async (token: string) => ((await (await fetch('/api/v1/businesses', { headers: { authorization: `Bearer ${token}` } })).json()) as Array<{ id: string }>)[0]!.id;
    for (let i = 0; i < 10; i++) {
      const r = await fetch('/api/v1/auth/refresh', { method: 'POST', headers: { 'x-touma-csrf': '1' } });
      if (r.ok) {
        const { accessToken } = await r.json();
        const res = await fetch(`/api/v1${path}`, { method: init.method ?? 'GET', headers: { authorization: `Bearer ${accessToken}`, 'x-business-id': await biz(accessToken), ...(init.body ? { 'content-type': 'application/json' } : {}) }, body: init.body ? JSON.stringify(init.body) : undefined });
        return { status: res.status, body: await res.json().catch(() => null) };
      }
      await new Promise((r2) => setTimeout(r2, 300));
    }
    throw new Error('no session');
  }, { path, init });
}
const day = (n: number) => new Date(Date.now() + 3_600_000 + n * 86_400_000).toISOString().slice(0, 10);

test('approval center on a phone: review, explicit confirmation, history snapshot, and an edit returns the post to pending approval', async ({ page }) => {
  await setup(page);
  const created = await api(page, '/calendar/entries', { method: 'POST', body: { title: 'Bissap promo', platform: 'FACEBOOK', caption: 'Fresh bissap juice, served cold.', hashtags: ['bissap'], localDate: day(4), localTime: '10:00' } });
  expect(created.status).toBe(201);
  const id = created.body.id as string;
  expect((await api(page, `/calendar/entries/${id}/submit`, { method: 'POST', body: {} })).status).toBe(200);

  await page.goto('/dashboard/calendar/approvals');
  const item = page.locator('[data-testid="approval-item"]', { hasText: 'Bissap promo' });
  await expect(item).toBeVisible();
  await expect(item).toContainText('Fresh bissap juice, served cold.'); // the preview the approver judges
  await expect(item).toContainText('Facebook');
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);

  // Approving needs an explicit confirmation in an accessible dialog; cancelling changes nothing.
  await item.getByTestId('quick-approve').click();
  const dialog = page.getByRole('dialog', { name: 'Approve this publication?' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Approving does not publish anything');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(item).toBeVisible();
  await item.getByTestId('quick-approve').click();
  await page.getByTestId('quick-approve-confirm').click();
  await expect(page.getByTestId('ready-list')).toContainText('Bissap promo');

  // The history shows what was approved.
  await page.getByTestId('ready-list').getByRole('button', { name: 'Bissap promo' }).click();
  await expect(page.getByTestId('entry-history')).toContainText('approved version');
  await page.keyboard.press('Escape');

  // An edit after approval withdraws it: the post is pending approval again and needs a new decision.
  const edit = await api(page, `/calendar/entries/${id}`, { method: 'PATCH', body: { caption: 'Fresh bissap juice, now with ginger.' } });
  expect(edit.status).toBe(200);
  expect(edit.body.status).toBe('IN_REVIEW');
  await page.reload();
  await expect(page.locator('[data-testid="pending-list"] [data-testid="approval-item"]', { hasText: 'Bissap promo' })).toBeVisible();
  await expect(page.getByTestId('ready-list')).toHaveCount(0); // nothing is ready any more
});
