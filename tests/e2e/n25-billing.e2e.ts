import { expect, test, type Page } from '@playwright/test';

/**
 * Billing screen and customer overview in a real browser (Chromium, phone size). The payment provider is the test-only simulator:
 * no money, no real card. The 72-hour trial starts without a card; the card step explains that TOUMA never sees card data.
 */
test.use({ viewport: { width: 390, height: 844 } });

async function setup(page: Page) {
  await page.goto('/register');
  await page.getByLabel('Full name').fill('Awa Mahamat');
  await page.getByLabel('Email').fill(`n25${Date.now()}${Math.floor(Math.random() * 1e6)}@example.com`);
  await page.getByLabel('Password').fill('Correct-Horse-9-Battery');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByLabel('Business name').fill('Maquis Awa');
  await page.getByLabel('Business type').selectOption('RESTAURANT');
  await page.getByLabel('Currency').selectOption('XAF');
  await page.getByRole('button', { name: 'Create my business' }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
}

test('billing: no plan, start the 72-hour trial, save a card (simulated), overview cards', async ({ page }) => {
  // The API needs the plans (normally seeded); the first trial call below only works if they exist, so this test creates none and relies on the seed.
  await setup(page);
  // Overview strip on the dashboard: simulated AI and the billing state.
  await expect(page.getByTestId('account-ai-mode')).toContainText('Simulated AI');
  await expect(page.getByTestId('account-billing-state')).toContainText('No plan');

  await page.goto('/dashboard/billing');
  await expect(page.getByTestId('billing-provider-note')).toContainText('Simulated payments');
  await expect(page.getByTestId('billing-state')).toHaveText('No plan');
  await expect(page.getByTestId('billing-cancel')).toHaveCount(0);

  await page.getByTestId('billing-start-trial').click();
  await expect(page.getByTestId('billing-state')).toHaveText('Free trial');
  await expect(page.getByText('Everything is available during your free trial.')).toBeVisible();
  await expect(page.getByTestId('billing-start-trial')).toHaveCount(0); // once per business

  await page.getByTestId('billing-card-setup').click();
  await expect(page.getByTestId('billing-card-note')).toContainText('never sees or stores your card number');
  await expect(page.getByTestId('billing-subscribe')).toHaveCount(0); // the provider must confirm the card first
  await expect(page.getByTestId('billing-history')).toContainText('Free trial started');
  // No card field exists anywhere on the page.
  await expect(page.locator('input[autocomplete^="cc-"], input[name*="card" i]')).toHaveCount(0);
});

test('billing menu entry and page are reachable on a phone', async ({ page }) => {
  await setup(page);
  await page.getByRole('button', { name: /menu/i }).click();
  await page.getByRole('dialog').getByRole('link', { name: 'Billing', exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard\/billing$/);
  await expect(page.getByTestId('billing-view')).toBeVisible();
});
