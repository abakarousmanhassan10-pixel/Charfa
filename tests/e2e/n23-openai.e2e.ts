import { expect, test, type Page } from '@playwright/test';

/**
 * Phase N23, AI analysis of a campaign in a real browser (Chromium, phone size): the button needs measurements first, the answer is
 * explained as AI reading of platform figures. The AI provider is the test-only one and the platform is the test-only simulator; nothing is posted anywhere.
 */
test.use({ timezoneId: 'Africa/Ndjamena', viewport: { width: 390, height: 844 } });

async function setup(page: Page) {
  await page.goto('/register');
  await page.getByLabel('Full name').fill('Awa Mahamat');
  await page.getByLabel('Email').fill(`n23${Date.now()}${Math.floor(Math.random() * 1e6)}@example.com`);
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

test('campaign AI analysis on a phone: needs measurements first, then explains them without claiming sales', async ({ page }) => {
  await setup(page);
  const product = await api(page, '/products', { method: 'POST', body: { name: 'Bissap juice', price: '1500', status: 'ACTIVE', features: ['Hibiscus flowers'], benefits: ['Refreshing'] } });
  expect(product.status).toBe(201);
  const camp = await api(page, '/campaigns', { method: 'POST', body: { name: 'Bissap launch', goalType: 'LAUNCH', productIds: [product.body.id] } });
  const id = camp.body.id as string;
  expect((await api(page, `/campaigns/${id}/plan`, { method: 'POST', body: { days: 10 } })).status).toBe(200);
  expect((await api(page, `/campaigns/${id}/content`, { method: 'POST', body: {} })).status).toBe(200);

  await page.goto('/dashboard/campaigns');
  await page.getByTestId('campaign-item').first().click();
  const ai = page.getByTestId('campaign-ai');
  await expect(ai.getByTestId('ai-analysis-button')).toBeDisabled(); // nothing measured yet
  await expect(ai).toContainText('Evaluate the campaign first');

  expect((await api(page, `/campaigns/${id}/metrics`, { method: 'POST', body: {} })).status).toBe(200);
  await page.reload();
  await page.getByTestId('campaign-item').first().click();
  await expect(ai.getByTestId('ai-analysis-button')).toBeEnabled();
  await ai.getByTestId('ai-analysis-button').click();
  const result = ai.getByTestId('ai-analysis-result');
  await expect(result).toBeVisible({ timeout: 30_000 });
  await expect(result).toContainText('no measurements yet'); // honest: nothing was published or measured
  await expect(result).toContainText('never spends, publishes or changes anything');
  await expect(result).not.toContainText(/sales (increased|grew)|ROI|guarantee/i);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
});
