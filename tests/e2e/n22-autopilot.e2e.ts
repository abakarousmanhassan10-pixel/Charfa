import { expect, test, type Page } from '@playwright/test';

/**
 * Phase N22, the merchant command center in a real browser (Chromium, phone size): entered costs, missing data, negative margin, decisions
 * for the merchant, scenarios and the emergency stop. Agents are deterministic and the platform is the test-only simulator; nothing is posted anywhere.
 */
test.use({ timezoneId: 'Africa/Ndjamena', viewport: { width: 390, height: 844 } });

async function setup(page: Page) {
  await page.goto('/register');
  await page.getByLabel('Full name').fill('Awa Mahamat');
  await page.getByLabel('Email').fill(`n22${Date.now()}${Math.floor(Math.random() * 1e6)}@example.com`);
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

test('command center on a phone: costs, missing data stays missing, negative margin, merchant decision, scenarios, emergency stop', async ({ page }) => {
  await setup(page);
  const product = await api(page, '/products', { method: 'POST', body: { name: 'Bissap juice', price: '1500', status: 'ACTIVE', features: ['Hibiscus flowers'], benefits: ['Refreshing'] } });
  expect(product.status).toBe(201);

  await page.goto('/dashboard/autopilot');
  await expect(page.getByTestId('autopilot-rule')).toContainText('never changes a price');
  await expect(page.getByTestId('origin')).toContainText('Simulated platforms');
  // No cost entered yet: the margin is not computed, and the page says so.
  await expect(page.getByTestId('profit-card')).toContainText('Cannot be computed: missing');
  await expect(page.getByTestId('health-card').locator('[data-section="salesData"]')).toHaveAttribute('data-status', 'MISSING');
  await expect(page.getByTestId('health-card').locator('[data-section="marketData"]')).toHaveAttribute('data-status', 'UNAVAILABLE');

  // Enter costs that make each order lose money.
  const form = page.getByTestId('costs-form');
  await form.getByLabel('Product').selectOption({ label: 'Bissap juice' });
  await form.getByLabel('Unit cost').fill('1400');
  await form.getByLabel('Shipping cost per order').fill('300');
  await form.getByLabel('Payment fee %').fill('2.5');
  await form.getByLabel('Fixed payment fee').fill('0');
  await form.getByLabel('Returns allowance %').fill('5');
  await page.getByTestId('save-costs').click();
  await expect(page.getByTestId('profit-card')).toContainText('Contribution: -312.50 XAF');
  await expect(page.getByTestId('profit-card')).toContainText('Loses money');
  await expect(page.getByTestId('profit-card')).toContainText('break-even price: 1837.84 XAF');

  await page.getByTestId('act-run').click();
  const decision = page.getByTestId('decisions-card').locator('[data-kind="NEGATIVE_MARGIN_REVIEW"]');
  await expect(decision).toBeVisible();
  await expect(decision).toContainText('loses 312.50');
  await expect(decision).toContainText('never changes a price');
  await expect(decision).toContainText('Medium confidence');
  await expect(page.getByTestId('agents-card')).toContainText('Last run: Completed');

  // Scenario: a simulation with explicit assumptions; a loss is flagged and nothing is spent.
  const sc = page.getByTestId('scenario-card');
  await sc.getByLabel('Product').selectOption({ label: 'Bissap juice' });
  await sc.getByLabel('What-if price').fill('2200');
  await page.getByTestId('simulate').click();
  const rows = page.getByTestId('scenario-results').locator('tbody tr');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText('Loss');
  await expect(sc).toContainText('not forecasts or guarantees');

  // The merchant decides. The emergency stop blocks everything until it is released.
  await page.getByTestId('act-stop').click();
  await expect(page.getByTestId('paused')).toBeVisible();
  await expect(page.getByTestId('act-run')).toBeDisabled();
  await expect(decision.getByRole('button', { name: 'Approve' })).toBeDisabled();
  await page.getByTestId('act-stop').click();
  await expect(page.getByTestId('paused')).toHaveCount(0);
  await decision.getByRole('button', { name: 'Reject' }).click();
  await expect(decision).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
});
