import { expect, test, type Page } from '@playwright/test';

/**
 * Phase N20, the campaign Director in a real browser (Chromium, phone size): plan, fact-checked drafts, send for approval, kill switch.
 * Agents are mocks and the platform is the test-only simulator; nothing is posted anywhere.
 */
test.use({ timezoneId: 'Africa/Ndjamena', viewport: { width: 390, height: 844 } });

async function setup(page: Page) {
  await page.goto('/register');
  await page.getByLabel('Full name').fill('Awa Mahamat');
  await page.getByLabel('Email').fill(`n20${Date.now()}${Math.floor(Math.random() * 1e6)}@example.com`);
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

test('campaign director on a phone: plan, drafts, send for approval (nothing approved), pause blocks agents, no horizontal scroll', async ({ page }) => {
  await setup(page);
  const product = await api(page, '/products', { method: 'POST', body: { name: 'Bissap juice', price: '1500', status: 'ACTIVE', features: ['Hibiscus flowers', 'Served cold'], benefits: ['Refreshing'] } });
  expect(product.status).toBe(201);

  await page.goto('/dashboard/campaigns');
  await expect(page.getByTestId('campaigns-rule')).toContainText('Nothing is published automatically');
  await page.getByLabel('Campaign name').fill('Bissap launch');
  await page.getByLabel('Product').selectOption({ label: 'Bissap juice' });
  await page.getByTestId('create-campaign').click();
  const detail = page.getByTestId('campaign-detail');
  await expect(detail.getByTestId('campaign-status')).toHaveText('Draft');

  await detail.getByTestId('step-plan').click();
  await expect(detail.getByTestId('campaign-status')).toHaveText('Planned');
  await expect(detail.getByTestId('market-note')).toContainText('nothing is estimated'); // no invented market data
  await expect(detail.getByTestId('plan')).toContainText('No advertising spend is planned');

  await detail.getByTestId('step-content').click();
  await expect(detail.getByTestId('campaign-status')).toHaveText('Drafts ready');
  const entries = detail.getByTestId('entries').locator('li');
  expect(await entries.count()).toBeGreaterThan(0);
  await expect(entries.first()).toHaveAttribute('data-status', 'DRAFT');

  await detail.getByTestId('step-submit').click();
  await expect(detail.getByTestId('campaign-status')).toHaveText('Awaiting approval');
  await expect(entries.first()).toHaveAttribute('data-status', 'IN_REVIEW');
  // The campaign cannot approve: the person does it, post by post, in the approvals center.
  await page.getByRole('link', { name: /approve posts one by one/i }).click();
  await expect(page).toHaveURL(/\/dashboard\/calendar\/approvals/);
  await expect(page.getByTestId('approval-item').first()).toBeVisible();

  await page.goBack();
  await page.getByTestId('campaign-item').first().click();
  await page.getByTestId('kill-switch').click();
  await expect(page.getByTestId('campaign-detail').getByText('Paused').first()).toBeVisible();
  await expect(page.getByTestId('step-plan')).toBeDisabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
});
