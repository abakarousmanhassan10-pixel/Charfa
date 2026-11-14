import { expect, test, type Page } from '@playwright/test';

/**
 * Diagnostic: the merchant's path to AI analysis and product descriptions in a real browser (Chromium, phone size): a new product is a
 * draft and the AI explains it, a simulated provider is labelled, then activation, analysis and description. The AI provider is the test-only one and the platform is the test-only simulator; nothing is posted anywhere.
 */
test.use({ timezoneId: 'Africa/Ndjamena', viewport: { width: 390, height: 844 } });

async function setup(page: Page) {
  await page.goto('/register');
  await page.getByLabel('Full name').fill('Awa Mahamat');
  await page.getByLabel('Email').fill(`aidiag${Date.now()}${Math.floor(Math.random() * 1e6)}@example.com`);
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

test('AI path on a phone: draft product explained, simulated AI labelled, then analysis and a product description work', async ({ page }) => {
  await setup(page);
  const created = await api(page, '/products', { method: 'POST', body: { name: 'Chapeau Savane', description: 'Chapeau a large bord', price: '4500', features: ['Large bord'], benefits: ['Garde au frais'] } });
  expect(created.status).toBe(201);
  expect(created.body.status).toBe('DRAFT'); // new products start as drafts

  // The AI says what is going on instead of looking broken.
  await page.goto('/dashboard/ai/content-generator');
  await expect(page.getByTestId('ai-simulated')).toContainText('Simulated AI');
  await expect(page.getByTestId('no-active-items')).toContainText('No active product or service yet');
  await expect(page.locator('#ai-item option')).toHaveCount(1); // only "Whole business": the draft is not offered
  await page.getByTestId('no-active-items').getByRole('link', { name: /Open Products/ }).click();
  await expect(page).toHaveURL(/\/dashboard\/products/);

  // A business with nothing active can still generate for the whole business (it used to fail with "duplicate hashtags").
  await page.goto('/dashboard/ai/content-generator');
  await page.getByRole('button', { name: /^Generate/ }).first().click();
  await expect(page.getByText('Generated content')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/did not pass validation/i)).toHaveCount(0);

  // Activate the product (the status hint tells the merchant why), then analyze it and write its description.
  expect(await api(page, `/products/${created.body.id}`, { method: 'PATCH', body: { status: 'ACTIVE' } }).then((r) => r.status)).toBe(200);
  await page.goto('/dashboard/ai/product-analysis');
  await page.locator('#ai-item').selectOption({ label: 'Chapeau Savane' });
  await page.getByRole('button', { name: /^Generate/ }).first().click();
  await expect(page.getByText('Product analysis · done')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('Verified benefits')).toBeVisible();

  await page.goto('/dashboard/ai/content-generator');
  await page.locator('#ai-platform').selectOption('ANY');
  await page.locator('#ai-format').selectOption({ label: 'Product description' });
  await page.locator('#ai-item').selectOption({ label: 'Chapeau Savane' });
  await page.getByRole('button', { name: /^Generate/ }).first().click();
  await expect(page.getByText('Generated content')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('Description', { exact: true }).first()).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
});

test('a gateway error is explained as "server starting up", not as a failed generation', async ({ page }) => {
  await setup(page);
  await page.route('**/api/v1/ai/business-analysis', (route) => route.fulfill({ status: 502, contentType: 'text/plain', body: 'Bad Gateway' }));
  await page.goto('/dashboard/ai/business-analysis');
  await page.getByRole('button', { name: /^Generate/ }).first().click();
  await expect(page.getByText(/server is starting up or temporarily unavailable/i)).toBeVisible();
  await expect(page.getByText('The generation failed. Please try again.')).toHaveCount(0);
});
