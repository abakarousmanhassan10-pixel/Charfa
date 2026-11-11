import { expect, test, type Page } from '@playwright/test';
import { Mailbox } from '../../apps/api/test/mailbox';

/**
 * Email-driven account flows through the real UI. The API sends real SMTP to a local capture
 * server; the test follows the link exactly as a user would click it.
 */
const mailbox = new Mailbox(2626);
const password = 'Correct-Horse-9-Battery';
const newPassword = 'Another-Strong-7-Secret';
const email = (p: string) => `${p}${Date.now()}${Math.floor(Math.random() * 1e6)}@example.com`;

test.describe.configure({ mode: 'serial' });
test.beforeAll(() => mailbox.start());
test.afterAll(() => mailbox.stop());

async function linkFor(to: string, tag: string) {
  const { mail } = await mailbox.waitFor(to, tag, 10_000);
  const url = /(https?:\/\/[^\s"<>]+#token=[A-Za-z0-9_-]+)/.exec(mail.raw)?.[1];
  expect(url, `link in ${tag} email`).toBeTruthy();
  return url!.replace('http://localhost:3100', '');
}

async function register(page: Page, address: string, name = 'Awa Mahamat') {
  await page.getByLabel('Full name').fill(name);
  await page.getByLabel('Email').fill(address);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Create account' }).click();
}

test('registration sends a verification email; the link verifies the account', async ({ page }) => {
  const address = email('verify');
  await page.goto('/register');
  await register(page, address);
  await expect(page).toHaveURL(/\/onboarding$/);
  await page.getByLabel('Business name').fill('Verify Shop');
  await page.getByRole('button', { name: 'Create my business' }).click();
  await expect(page.getByTestId('verify-banner')).toBeVisible();

  const link = await linkFor(address, 'email-verification');
  await page.goto(link);
  await expect(page.getByTestId('verify-ok')).toBeVisible();
  // The token is removed from the address bar after it is read.
  expect(page.url()).not.toContain('token=');
  // Reusing the link fails: tokens are single use. (Leave the page first so the hash-only URL is a full load.)
  await page.goto('/');
  await page.goto(link);
  await expect(page.getByTestId('verify-invalid')).toBeVisible();

  await page.goto('/dashboard');
  await expect(page.getByRole('heading', { name: 'Welcome back, Awa' })).toBeVisible();
  await expect(page.getByTestId('verify-banner')).toHaveCount(0);
});

test('forgot password → email link → new password → sign in', async ({ page }) => {
  const address = email('reset');
  await page.goto('/register');
  await register(page, address);
  await expect(page).toHaveURL(/\/onboarding$/);
  await page.context().clearCookies();

  await page.goto('/login');
  await page.getByRole('link', { name: 'Forgot password?' }).click();
  await expect(page).toHaveURL(/\/forgot-password$/);
  await page.getByLabel('Email').fill(address);
  await page.getByRole('button', { name: 'Send reset link' }).click();
  await expect(page.getByTestId('forgot-sent')).toBeVisible();

  await page.goto(await linkFor(address, 'password-reset'));
  await page.getByLabel('New password').fill(newPassword);
  await page.getByLabel('Confirm password').fill(newPassword);
  await page.getByRole('button', { name: 'Set new password' }).click();
  await expect(page.getByTestId('reset-done')).toBeVisible();
  await mailbox.waitFor(address, 'password-changed');

  await page.goto('/login');
  await page.getByLabel('Email').fill(address);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByTestId('form-error')).toHaveText('Invalid email or password.');
  await page.getByLabel('Password').fill(newPassword);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/onboarding$/);
});

test('owner invites a teammate who registers from the link and joins with the invited role', async ({ page, browser }) => {
  const owner = email('owner');
  const invitee = email('invitee');
  await page.goto('/register');
  await register(page, owner, 'Owner Person');
  await page.getByLabel('Business name').fill('Invite Shop');
  await page.getByRole('button', { name: 'Create my business' }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  // Inviting requires a verified email.
  await page.goto(await linkFor(owner, 'email-verification'));
  await expect(page.getByTestId('verify-ok')).toBeVisible();

  await page.goto('/settings/business');
  await page.getByLabel('Email', { exact: true }).fill(invitee);
  await page.getByLabel('Role', { exact: true }).selectOption('VIEWER');
  await page.getByRole('button', { name: 'Send invitation' }).click();
  await expect(page.getByTestId('invitations')).toContainText(invitee);

  const link = await linkFor(invitee, 'invitation');
  const ctx = await browser.newContext();
  const guest = await ctx.newPage();
  await guest.goto(link);
  await expect(guest.getByTestId('invite-details')).toContainText('Invite Shop');
  await guest.getByRole('link', { name: 'Create account' }).click();
  await expect(guest).toHaveURL(/\/register\?next=/);
  await expect(guest.getByRole('button', { name: 'Create account' })).toBeVisible();
  await expect(guest.getByLabel('Email')).toHaveValue(invitee);
  await guest.getByLabel('Full name').fill('Invited Teammate');
  await guest.getByLabel('Password').fill(password);
  await guest.getByRole('button', { name: 'Create account' }).click();
  await expect(guest).toHaveURL(/\/invitations\/accept$/);
  await guest.getByRole('button', { name: 'Accept invitation' }).click();
  await expect(guest).toHaveURL(/\/dashboard$/);
  await expect(guest.getByText('Here is what is happening at Invite Shop.')).toBeVisible();
  // The invitation can only be used once.
  await guest.goto('/');
  await guest.goto(link);
  await expect(guest.getByTestId('invite-error')).toBeVisible();
  await ctx.close();

  await page.reload();
  await expect(page.getByTestId('members')).toContainText(invitee);
  await expect(page.getByTestId('invitations')).toHaveCount(0);
});
