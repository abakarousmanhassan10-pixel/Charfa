import { execSync } from 'child_process';
import { expect, test, type Page } from '@playwright/test';

const DB = (process.env.TEST_DATABASE_URL ?? 'postgresql://touma:touma_dev_password@localhost:5432/touma_test').split('?')[0]!;
const sql = (q: string) => execSync(`psql -v ON_ERROR_STOP=1 "${DB}" -At`, { input: q }).toString().trim();

/**
 * Billing engine in a real browser (Chromium, phone size). The payment provider is the test-only simulator: "Simulation — no real payment" is shown,
 * no money moves and no real card exists. A subscription is extended only after the (simulated) provider confirms a payment to the server.
 */
test.use({ viewport: { width: 390, height: 844 } });

async function setup(page: Page) {
  await page.goto('/register');
  await page.getByLabel('Full name').fill('Awa Mahamat');
  await page.getByLabel('Email').fill(`n26${Date.now()}${Math.floor(Math.random() * 1e6)}@example.com`);
  await page.getByLabel('Password').fill('Correct-Horse-9-Battery');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByLabel('Business name').fill('Maquis Awa');
  await page.getByLabel('Business type').selectOption('RESTAURANT');
  await page.getByLabel('Currency').selectOption('XAF');
  await page.getByRole('button', { name: 'Create my business' }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
}

test('manual renewal: trial, payment page, nothing changes until the provider confirms, invoice, plan change, cancel and resume', async ({ page }) => {
  await setup(page);
  await expect(page.getByTestId('account-billing-state')).toContainText('No plan');
  await page.goto('/dashboard/billing');
  await expect(page.getByTestId('billing-simulation-banner')).toHaveText('Simulation — no real payment');
  await expect(page.getByTestId('billing-state')).toHaveText('No plan');
  await expect(page.getByTestId('billing-methods')).toContainText('Simulation');
  // Prices come from integer minor units: 19.00 monthly, 190.00 yearly.
  await expect(page.getByTestId('billing-start')).toContainText('$19.00');
  await expect(page.getByTestId('billing-start')).toContainText('$190.00');
  await expect(page.getByTestId('billing-plan-usage')).toContainText('AI generations this month: 0 of');
  await expect(page.getByTestId('usage-agents')).toContainText('All AI agents are available'); // no plan restriction before a plan is chosen
  await page.getByTestId('billing-mode-MANUAL').check();
  await page.getByTestId('billing-start-trial').click();
  await expect(page.getByTestId('billing-state')).toHaveText('Free trial');
  await expect(page.getByTestId('billing-mode')).toHaveText('Manual renewal');
  await expect(page.getByTestId('billing-next-payment')).toContainText('$19.00');
  await expect(page.getByTestId('usage-agents')).toContainText('AI agents included in your plan: 5');
  await expect(page.getByTestId('usage-features')).toContainText('sales');
  await expect(page.getByTestId('billing-invoices-empty')).toBeVisible();

  // Renew: a payment page opens, but the subscription is unchanged until the provider confirms.
  await page.getByTestId('billing-renew').click();
  await expect(page.getByTestId('billing-session')).toContainText('Pay $19.00');
  await expect(page.getByTestId('billing-session')).toContainText('not when you come back to this page');
  await expect(page.getByTestId('billing-state')).toHaveText('Free trial');
  await expect(page.getByTestId('billing-invoice')).toHaveCount(0);

  // A declined payment changes nothing; a retry succeeds.
  await page.getByTestId('billing-sim-declined').click();
  await expect(page.getByTestId('billing-state')).toHaveText('Free trial');
  await page.getByTestId('billing-renew').click();
  await page.getByTestId('billing-sim-success').click();
  await expect(page.getByTestId('billing-state')).toHaveText('Active');
  await expect(page.getByTestId('billing-invoice')).toHaveCount(1);
  await expect(page.getByTestId('billing-invoice')).toContainText('SIM-');
  await expect(page.getByTestId('billing-invoice-simulated')).toHaveText('Simulated');
  await expect(page.getByTestId('billing-renew')).toHaveCount(0); // paid for the month: renewal opens a few days before the end

  // Plan change applies at the next renewal.
  await page.getByTestId('billing-change-plan').selectOption('PRO');
  await page.getByTestId('billing-change-interval').selectOption('YEARLY');
  await page.getByTestId('billing-change-submit').click();
  await expect(page.getByTestId('billing-pending-change')).toContainText('PRO');
  await expect(page.getByTestId('billing-pending-change')).toContainText('next renewal');
  await expect(page.getByTestId('billing-next-payment')).toContainText('$490.00');

  await page.getByTestId('billing-cancel').click();
  await expect(page.getByTestId('billing-cancel-pending')).toBeVisible();
  await page.getByTestId('billing-resume').click();
  await expect(page.getByTestId('billing-cancel-pending')).toHaveCount(0);
  // No card field exists anywhere on the page.
  await expect(page.locator('input[autocomplete^="cc-"], input[name*="card" i]')).toHaveCount(0);
});

test('automatic renewal: consent is required, card page, schedule, the due date charges and extends', async ({ page }) => {
  await setup(page);
  await page.goto('/dashboard/billing');
  await page.getByTestId('billing-mode-AUTO').check();
  await expect(page.getByTestId('billing-start-trial')).toBeDisabled(); // no consent yet
  await page.getByTestId('billing-consent').check();
  await page.getByTestId('billing-start-trial').click();
  await expect(page.getByTestId('billing-mode')).toHaveText('Automatic renewal');
  await expect(page.getByTestId('billing-state')).toHaveText('Free trial');

  await page.getByTestId('billing-card-setup').click();
  await expect(page.getByTestId('billing-card-note')).toContainText('never sees or stores your card number');
  await expect(page.getByTestId('billing-subscribe')).toHaveCount(0); // the provider must confirm the card first
  await page.getByTestId('billing-sim-card').click();
  await page.getByTestId('billing-subscribe').click();
  await expect(page.getByTestId('billing-sim-due')).toBeVisible();

  // The renewal falls due and the (simulated) provider declines once, then charges.
  await page.getByTestId('billing-sim-due-declined').click();
  await expect(page.getByTestId('billing-state')).toHaveText('Payment failed — retrying');
  await expect(page.getByTestId('billing-failed')).toHaveText('1');
  await page.getByTestId('billing-sim-due-success').click();
  await expect(page.getByTestId('billing-state')).toHaveText('Active');
  await expect(page.getByTestId('billing-invoice')).toHaveCount(1);

  // Turn automatic renewal off: back to manual.
  await page.getByTestId('billing-disable-auto').click();
  await expect(page.getByTestId('billing-mode')).toHaveText('Manual renewal');
  await expect(page.getByTestId('billing-sim-due')).toHaveCount(0);
});

test('billing page is reachable from the phone menu; the platform billing overview refuses non-administrators', async ({ page }) => {
  await setup(page);
  await page.getByRole('button', { name: /menu/i }).click();
  await page.getByRole('dialog').getByRole('link', { name: 'Billing', exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard\/billing$/);
  await expect(page.getByTestId('billing-view')).toBeVisible();
  await page.goto('/dashboard/operations/billing');
  await expect(page.getByTestId('billing-admin-forbidden')).toBeVisible();
});

test('platform administrator: provider approval and the production lock (real payments stay blocked even when a decision is recorded)', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 }); // the sign-out button is in the desktop header
  await setup(page);
  const email = `n27-admin-${Date.now()}@example.com`;
  sql(`update "User" set "platformRole" = 'SUPER_ADMIN', email = '${email}' where id = (select "userId" from "Membership" order by "createdAt" desc limit 1)`);
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('Correct-Horse-9-Battery');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/(dashboard|onboarding)/);
  await page.goto('/dashboard/operations/billing');
  await expect(page.getByTestId('billing-admin')).toBeVisible();
  await expect(page.getByTestId('admin-environment')).toHaveText('sandbox');
  // Nothing is approved, and every reason real payments are blocked is shown.
  for (const p of ['paddle-sandbox', 'lemonsqueezy', 'payoneer', 'iyzico']) await expect(page.getByTestId(`admin-approval-${p}`)).toHaveText('Not submitted');
  await expect(page.getByTestId('admin-gate-paddle-sandbox')).toContainText('this build blocks live payments');
  await expect(page.getByTestId('admin-gate-paddle-sandbox')).toContainText('provider has not approved TOUMA');
  // Recording an approval needs the provider's written reference...
  await page.getByTestId('admin-approval-status').selectOption('APPROVED');
  await page.getByTestId('admin-approval-save').click();
  await expect(page.getByTestId('admin-approval-error')).toBeVisible();
  // ...and even with it, real payments stay blocked.
  await page.getByTestId('admin-approval-reference').fill('provider-ticket-4242');
  await page.getByTestId('admin-approval-save').click();
  await expect(page.getByTestId('admin-approval-paddle-sandbox')).toHaveText('Approved');
  await expect(page.getByTestId('admin-gate-paddle-sandbox')).toContainText('this build blocks live payments');
  await expect(page.getByTestId('admin-gate-paddle-sandbox')).toContainText('adapter has no live mode');
  await expect(page.getByTestId('admin-sub-filter')).toBeVisible();
  sql(`update "PaymentProviderAccount" set "approvalStatus" = 'NOT_SUBMITTED', "approvalReference" = null, "approvedAt" = null where provider = 'paddle-sandbox'`);
});
