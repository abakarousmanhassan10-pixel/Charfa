import { expect, test } from '@playwright/test';

const password = 'Correct-Horse-9-Battery';
const email = () => `e2e${Date.now()}${Math.floor(Math.random() * 1e6)}@example.com`;

test('landing page renders and links to registration', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Your Business. Your AI Marketing Team.');
  await expect(page).toHaveTitle('TOUMA AI — Your Business. Your AI Marketing Team.');
  await page.getByRole('link', { name: 'Start free' }).click();
  await expect(page).toHaveURL(/\/register$/);
});

test('register → dashboard → reload keeps session → logout → login', async ({ page }) => {
  const address = email();
  await page.goto('/register');
  await page.getByLabel('Full name').fill('Awa Mahamat');
  await page.getByLabel('Email').fill(address);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Create account' }).click();

  // New accounts without a business are sent to onboarding.
  await expect(page).toHaveURL(/\/onboarding$/);
  await expect(page.getByRole('heading', { name: 'Set up your business' })).toBeVisible();

  // Tokens never land in web storage.
  const storage = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }));
  expect(storage).not.toMatch(/ey[A-Za-z0-9_-]{10,}\./);
  // Refresh cookie is httpOnly (not visible to JS).
  expect(await page.evaluate(() => document.cookie)).not.toContain('touma_rt');

  await page.reload();
  await expect(page.getByRole('heading', { name: 'Set up your business' })).toBeVisible();

  await page.goto('/login');
  await page.goto('/dashboard');
  await expect(page).toHaveURL(/\/onboarding$/);
  await page.getByLabel('Business name').fill('Session Shop');
  await page.getByRole('button', { name: 'Create my business' }).click();
  await expect(page).toHaveURL(/\/dashboard$/);

  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.goto('/dashboard');
  await expect(page).toHaveURL(/\/login$/);

  await page.getByLabel('Email').fill(address);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByRole('heading', { name: 'Welcome back, Awa' })).toBeVisible();
});

test('wrong password shows a generic error', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email());
  await page.getByLabel('Password').fill('Wrong-password-1');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByTestId('form-error')).toHaveText('Invalid email or password.');
});

test('client-side validation blocks weak passwords', async ({ page }) => {
  await page.goto('/register');
  await page.getByLabel('Full name').fill('X');
  await page.getByLabel('Email').fill(email());
  await page.getByLabel('Password').fill('weak');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByTestId('form-error')).toBeVisible();
  await expect(page).toHaveURL(/\/register$/);
});

test('French locale switch persists and sets lang attribute', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Language').selectOption('fr');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Votre entreprise. Votre équipe marketing IA.');
  await expect(page.locator('html')).toHaveAttribute('lang', 'fr');
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
  await page.goto('/login');
  await expect(page.getByRole('heading', { name: 'Bon retour' })).toBeVisible();
});

test('dashboard is not reachable anonymously', async ({ page }) => {
  await page.goto('/dashboard');
  await expect(page).toHaveURL(/\/login$/);
});
