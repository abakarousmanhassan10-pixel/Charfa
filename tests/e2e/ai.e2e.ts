import { expect, test, type Page } from '@playwright/test';

/** Full-stack TOUMA AI flows. The API runs with the TEST-ONLY deterministic AI provider. */
async function setup(page: Page) {
  await page.goto('/register');
  await page.getByLabel('Full name').fill('Awa Mahamat');
  await page.getByLabel('Email').fill(`ai${Date.now()}${Math.floor(Math.random() * 1e6)}@example.com`);
  await page.getByLabel('Password').fill('Correct-Horse-9-Battery');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByLabel('Business name').fill('Maquis Awa');
  await page.getByLabel('Business type').selectOption('RESTAURANT');
  await page.getByLabel('Currency').selectOption('XAF');
  await page.getByRole('button', { name: 'Create my business' }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  // Seed an ACTIVE product through the same API the UI uses.
  await page.evaluate(async () => {
    // The app refreshes its own session concurrently; retry if this helper's token got rotated away.
    let accessToken = '';
    let biz: { id: string } | undefined;
    for (let i = 0; i < 5 && !biz; i++) {
      accessToken = (await (await fetch('/api/v1/auth/refresh', { method: 'POST', headers: { 'x-touma-csrf': '1' } })).json()).accessToken;
      const res = await fetch('/api/v1/businesses', { headers: { authorization: `Bearer ${accessToken}` } });
      if (res.ok) biz = (await res.json())[0];
      else await new Promise((r) => setTimeout(r, 200));
    }
    if (!biz) throw new Error('could not seed test data');
    await fetch('/api/v1/products', {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}`, 'x-business-id': biz.id, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Bissap juice', price: '1500', status: 'ACTIVE', features: ['Hibiscus flowers'], benefits: ['Refreshing'] }),
    });
    await fetch('/api/v1/products', {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}`, 'x-business-id': biz.id, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Unreleased dish', status: 'DRAFT' }),
    });
  });
}

test('overview shows engine status and navigation', async ({ page }) => {
  await setup(page);
  await page.getByRole('navigation', { name: 'Menu' }).getByRole('link', { name: 'TOUMA AI' }).click();
  await expect(page).toHaveURL(/\/dashboard\/ai$/);
  await expect(page.getByTestId('ai-engine-status')).toContainText('Configured');
  await expect(page.getByTestId('ai-engine-status')).toContainText('gpt-4o-mini');
  await expect(page.getByTestId('usage-report')).toContainText('Token consumption');
  await expect(page.getByRole('navigation', { name: 'TOUMA AI' }).getByRole('link')).toHaveCount(6);
});

test('content generator: generate, edit, save draft, regenerate, history', async ({ page }) => {
  await setup(page);
  await page.goto('/dashboard/ai/content-generator');
  await page.getByLabel('Platform').selectOption('INSTAGRAM');
  await page.getByLabel('Format').selectOption('INSTAGRAM_CAROUSEL');
  await page.getByLabel('Content type').selectOption('PROMOTIONAL');
  await page.getByLabel('Tone').selectOption('PLAYFUL');
  await page.getByLabel('Output language').selectOption('fr');
  const items = page.getByLabel('Product or service');
  await expect(items.locator('option', { hasText: 'Bissap juice' })).toHaveCount(1);
  await expect(items.locator('option', { hasText: 'Unreleased dish' })).toHaveCount(0); // drafts are not AI facts
  await items.selectOption({ label: 'Bissap juice' });
  await page.getByRole('button', { name: 'Generate', exact: true }).click();

  const editor = page.getByTestId('content-editor');
  await expect(editor).toBeVisible();
  await expect(page.getByTestId('ai-steps')).toContainText('Business analysis · done');
  await expect(page.getByTestId('ai-steps')).toContainText('Product analysis · done');
  await expect(page.getByTestId('ai-usage')).toContainText('tokens');
  await expect(editor).toContainText('Instagram carousel');
  await expect(editor.getByLabel('Slide 1 heading')).toBeVisible();

  await editor.getByLabel('Caption / text').fill('Notre jus de bissap aux fleurs d’hibiscus, à partager entre amis.');
  await expect(editor).toContainText('Edited');
  await editor.getByRole('button', { name: 'Save draft' }).click();
  await expect(editor.getByRole('status')).toHaveText('Draft saved (version 1).');

  await editor.getByLabel('What should change when regenerating? (optional)').fill('Plus court');
  await editor.getByRole('button', { name: 'Regenerate' }).click();
  await expect(page.getByTestId('ai-steps')).toContainText('Product analysis · reused');
  await expect(editor.getByRole('status')).toHaveCount(0);

  await page.getByRole('link', { name: 'History' }).click();
  const history = page.getByTestId('history-list');
  await expect(history.locator('li')).toHaveCount(4); // business analysis, product analysis, content, regenerated content
  await expect(history).toContainText('Draft');
  await expect(history).toContainText('regenerated');
  await history.getByRole('button').filter({ hasText: 'Draft' }).click();
  await expect(page.getByRole('dialog').getByTestId('content-editor')).toContainText('Notre jus de bissap');
});

test('business analysis, product analysis and strategy pages', async ({ page }) => {
  await setup(page);
  await page.goto('/dashboard/ai/business-analysis');
  await expect(page.getByText('No business analysis yet.')).toBeVisible();
  await page.getByRole('button', { name: 'Generate', exact: true }).click();
  await expect(page.getByTestId('business-analysis')).toContainText('Target segments');

  await page.getByRole('link', { name: 'Product analysis' }).click();
  await page.getByLabel('Product or service').selectOption({ label: 'Bissap juice' });
  await page.getByRole('button', { name: 'Generate', exact: true }).click();
  const pa = page.getByTestId('product-analysis');
  await expect(pa).toContainText('Hibiscus flowers');
  await expect(pa).toContainText('Needs your input');

  await page.getByRole('link', { name: 'Marketing strategy' }).click();
  await page.getByLabel('Facebook').uncheck();
  await page.getByLabel('TikTok').check();
  await page.getByLabel('Goal (optional)').fill('More weekday lunch orders');
  await page.getByRole('button', { name: 'Generate', exact: true }).click();
  await expect(page.getByTestId('strategy-INSTAGRAM')).toBeVisible();
  await expect(page.getByTestId('strategy-TIKTOK')).toBeVisible();
  await expect(page.getByTestId('strategy-FACEBOOK')).toHaveCount(0);
  await expect(page.getByTestId('ai-steps')).toContainText('Business analysis · reused');
});

test('Arabic output is edited right-to-left', async ({ page }) => {
  await setup(page);
  await page.goto('/dashboard/ai/content-generator');
  await page.getByLabel('Platform').selectOption('FACEBOOK');
  await page.getByLabel('Output language').selectOption('ar');
  await page.getByRole('button', { name: 'Generate', exact: true }).click();
  const caption = page.getByTestId('content-editor').getByLabel('Caption / text');
  await expect(caption).toHaveAttribute('dir', 'rtl');
  await expect(caption).toHaveValue(/\p{Script=Arabic}/u);
});
