import { expect, test, type Page } from '@playwright/test';

/**
 * Phase N21, the business control center in a real browser (Chromium, phone size): pending approvals, simulated-data label, alerts,
 * recommendations and the merchant decision. Agents are mocks and the platform is the test-only simulator; nothing is posted anywhere.
 */
test.use({ timezoneId: 'Africa/Ndjamena', viewport: { width: 390, height: 844 } });

async function setup(page: Page) {
  await page.goto('/register');
  await page.getByLabel('Full name').fill('Awa Mahamat');
  await page.getByLabel('Email').fill(`n21${Date.now()}${Math.floor(Math.random() * 1e6)}@example.com`);
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

test('control center on a phone: simulated data is labelled, approvals wait for a person, alerts and recommendations come from the data', async ({ page }) => {
  await setup(page);
  const product = await api(page, '/products', { method: 'POST', body: { name: 'Bissap juice', price: '1500', status: 'ACTIVE', features: ['Hibiscus flowers'], benefits: ['Refreshing'] } });
  expect(product.status).toBe(201);
  const camp = await api(page, '/campaigns', { method: 'POST', body: { name: 'Bissap launch', goalType: 'LAUNCH', productIds: [product.body.id] } });
  expect(camp.status).toBe(201);
  const id = camp.body.id as string;
  expect((await api(page, `/campaigns/${id}/plan`, { method: 'POST', body: { days: 10 } })).status).toBe(200);
  expect((await api(page, `/campaigns/${id}/content`, { method: 'POST', body: {} })).status).toBe(200);
  expect((await api(page, `/campaigns/${id}/submit`, { method: 'POST', body: {} })).status).toBe(200);

  await page.goto('/dashboard/intelligence');
  await expect(page.getByTestId('data-origin')).toContainText('Simulated platforms');
  await expect(page.getByTestId('data-origin')).toContainText('0 real');
  expect(Number(await page.getByTestId('pending-count').innerText())).toBeGreaterThan(0);
  await expect(page.getByTestId('campaigns-card')).toContainText('Bissap launch');

  await page.getByTestId('act-scan').click();
  await expect(page.getByTestId('alerts-card')).toContainText('lack a description'); // missing product data, from the catalog
  await page.getByTestId('act-generate').click();
  const recs = page.getByTestId('recs-card').locator('li');
  await expect(recs.first()).toBeVisible();
  await expect(page.getByTestId('recs-card')).toContainText('Complete the product data');
  await page.getByTestId('act-evaluate').click();
  await expect(page.getByTestId('eval-note')).toContainText('Scores');
  await expect(page.getByTestId('cost-card')).toContainText('simulated agents are free');

  // Rejecting is the merchant's decision and removes the proposal from the list.
  const before = await recs.count();
  await recs.first().getByRole('button', { name: 'Reject' }).click();
  await expect(recs).toHaveCount(before - 1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
});
