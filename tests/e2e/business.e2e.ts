import { expect, test, type Page } from '@playwright/test';

const password = 'Correct-Horse-9-Battery';

async function signUp(page: Page, name = 'Moussa Abakar') {
  await page.goto('/register');
  await page.getByLabel('Full name').fill(name);
  await page.getByLabel('Email').fill(`biz${Date.now()}${Math.floor(Math.random() * 1e6)}@example.com`);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL(/\/onboarding$/);
}

async function onboard(page: Page, name: string) {
  await page.getByLabel('Business name').fill(name);
  await page.getByLabel('Business type').selectOption('RESTAURANT');
  await page.getByLabel('Country code').fill('td');
  await page.getByLabel('Timezone').selectOption('Africa/Ndjamena');
  await page.getByLabel('Currency').selectOption('XAF');
  await page.getByLabel('Brand voice').fill('Warm and generous');
  await page.getByRole('button', { name: 'Create my business' }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
}

test('onboarding creates a business and the dashboard shows only real data', async ({ page }) => {
  await signUp(page);
  await onboard(page, 'Chez Moussa');

  await expect(page.getByRole('heading', { name: 'Welcome back, Moussa' })).toBeVisible();
  const info = page.getByTestId('business-info');
  await expect(info).toContainText('Restaurant');
  await expect(info).toContainText('TD');
  await expect(info).toContainText('Africa/Ndjamena');
  await expect(info).toContainText('XAF');
  await expect(info).toContainText('Owner');

  // No fake connections, content or publications.
  const accounts = page.getByTestId('connected-accounts');
  for (const p of ['Instagram', 'Facebook', 'TikTok', 'YouTube']) await expect(accounts).toContainText(p);
  await expect(accounts.getByText('Not connected')).toHaveCount(4);
  await expect(page.getByTestId('content-overview')).toContainText('No content yet');
  await expect(page.getByTestId('upcoming-publications')).toContainText('No publications scheduled.');
});

test('validation errors are shown inline during onboarding', async ({ page }) => {
  await signUp(page);
  await page.getByLabel('Business name').fill('X');
  await page.getByLabel('Website (optional)').fill('not-a-url');
  await page.getByRole('button', { name: 'Create my business' }).click();
  await expect(page.getByTestId('form-error')).toBeVisible();
  await expect(page.getByLabel('Business name')).toHaveAttribute('aria-invalid', 'true');
  await expect(page).toHaveURL(/\/onboarding$/);
});

test('business settings: edit, persist, switch businesses, delete with confirmation', async ({ page }) => {
  await signUp(page);
  await onboard(page, 'First Shop');

  await page.getByRole('link', { name: 'Business settings' }).first().click();
  await expect(page.getByRole('heading', { name: 'Business settings' })).toBeVisible();
  await page.getByLabel('Industry (optional)').fill('Street food');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('status')).toHaveText('Saved');
  await page.reload();
  await expect(page.getByLabel('Industry (optional)')).toHaveValue('Street food');
  await expect(page.getByTestId('members')).toContainText('Owner');

  // Second business + switcher.
  await page.goto('/dashboard');
  await page.getByRole('link', { name: 'Add another business' }).click();
  await onboard(page, 'Second Shop');
  const switcher = page.getByLabel('Active business');
  await expect(switcher).toHaveValue(/.+/);
  await switcher.selectOption({ label: 'First Shop' });
  await expect(page.getByText('Here is what is happening at First Shop.')).toBeVisible();
  await expect(page.getByTestId('business-info')).toContainText('Street food');

  // Delete requires typing the exact name.
  await page.goto('/settings/business');
  const del = page.getByRole('button', { name: 'Delete business' });
  await expect(del).toBeDisabled();
  await page.getByLabel(/Business name: First Shop/).fill('First Shop');
  await del.click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByLabel('Active business').locator('option')).toHaveCount(1);
  await expect(page.getByText('Here is what is happening at Second Shop.')).toBeVisible();
});

test('user profile: update name, language and timezone', async ({ page }) => {
  await signUp(page, 'Fatime Ali');
  await onboard(page, 'Profile Shop');
  await page.goto('/settings/profile');
  await page.getByLabel('Full name').fill('Fatimé Ali');
  await page.getByLabel('Timezone').selectOption('Europe/Paris');
  await page.getByLabel('Language').first().selectOption('fr');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('heading', { name: 'Profil utilisateur' })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'fr');
  await page.goto('/dashboard');
  await expect(page.getByRole('heading', { name: 'Bon retour, Fatimé' })).toBeVisible();
});

test.describe('mobile', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('navigation drawer works and the layout has no horizontal scroll', async ({ page }) => {
    await signUp(page);
    await onboard(page, 'Mobile Shop');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await page.getByRole('button', { name: 'Menu' }).click();
    const drawer = page.getByRole('dialog', { name: 'Menu' });
    await expect(drawer).toBeVisible();
    await drawer.getByRole('link', { name: 'Profile' }).click();
    await expect(page).toHaveURL(/\/settings\/profile$/);
    await expect(drawer).toBeHidden();
  });
});
