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
  // Seed an ACTIVE product through the same API the UI uses. Every request is checked and retried: the app
  // rotates its refresh token concurrently, which can invalidate this helper's access token for a moment.
  await page.evaluate(async () => {
    const call = async (path: string, init?: { method: string; body: unknown; businessId: string }) => {
      for (let i = 0; i < 8; i++) {
        const refreshed = await fetch('/api/v1/auth/refresh', { method: 'POST', headers: { 'x-touma-csrf': '1' } });
        if (refreshed.ok) {
          const { accessToken } = await refreshed.json();
          const res = await fetch(path, {
            method: init?.method ?? 'GET',
            headers: { authorization: `Bearer ${accessToken}`, ...(init ? { 'x-business-id': init.businessId, 'content-type': 'application/json' } : {}) },
            body: init ? JSON.stringify(init.body) : undefined,
          });
          if (res.ok) return res.json();
        }
        await new Promise((r) => setTimeout(r, 250));
      }
      throw new Error(`could not call ${path}`);
    };
    const biz = (await call('/api/v1/businesses'))[0] as { id: string };
    await call('/api/v1/products', { method: 'POST', businessId: biz.id, body: { name: 'Bissap juice', price: '1500', status: 'ACTIVE', features: ['Hibiscus flowers'], benefits: ['Refreshing'] } });
    await call('/api/v1/products', { method: 'POST', businessId: biz.id, body: { name: 'Unreleased dish', status: 'DRAFT' } });
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

test('generation runs in the background: queued and retry states are shown, the result arrives', async ({ page }) => {
  await setup(page);
  await page.goto('/dashboard/ai/business-analysis');
  // Render the "waiting to retry" state deterministically: the first status poll reports a retry in progress.
  let first = true;
  await page.route('**/api/v1/ai/generations/*/status', async (route) => {
    if (!first) return route.continue();
    first = false;
    await route.fulfill({
      json: { id: 'x', task: 'BUSINESS_ANALYSIS', status: 'QUEUED', retrying: true, final: false, resultAvailable: false, attempt: 1, maxAttempts: 3, errorCode: 'AI_PROVIDER_RATE_LIMIT', errorMessage: null, steps: [{ step: 'context', status: 'done' }] },
    });
  });
  await page.getByRole('button', { name: 'Generate', exact: true }).click();
  const job = page.getByTestId('ai-job');
  await expect(job).toBeVisible();
  await expect(job).toHaveAttribute('data-retrying', 'true');
  await expect(job).toContainText('Retrying (attempt 2 of 3)');
  await expect(job).toContainText('You can leave this page');
  // The real worker finishes the job and the result replaces the progress.
  await expect(page.getByTestId('business-analysis')).toContainText('Target segments');
  await expect(page.getByTestId('ai-job')).toHaveCount(0);
});

test('AI content needs human approval; editing withdraws it; unsupported facts block it', async ({ page }) => {
  await setup(page);
  await page.goto('/dashboard/ai/content-generator');
  await page.getByLabel('Platform').selectOption('FACEBOOK');
  await page.getByLabel('Format').selectOption('FACEBOOK_PROMOTIONAL_POST');
  await page.getByLabel('Product or service').selectOption({ label: 'Bissap juice' });
  await page.getByRole('button', { name: 'Generate', exact: true }).click();
  const editor = page.getByTestId('content-editor');
  await expect(editor).toBeVisible();
  await expect(page.getByTestId('ai-quality')).toHaveAttribute('data-passed', 'true');

  const review = page.getByTestId('ai-review');
  await expect(review).toContainText('Save the draft to start the review.');
  await editor.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByTestId('ai-review-status')).toHaveText('Draft');
  await review.getByRole('button', { name: 'Submit for review' }).click();
  await expect(page.getByTestId('ai-review-status')).toHaveText('In review');
  await review.getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByTestId('ai-review-status')).toHaveText('Approved');
  await expect(review).toContainText('Approved on');

  // Editing the approved text withdraws the approval.
  await editor.getByLabel('Caption / text').fill('Notre jus de bissap aux fleurs d’hibiscus, servi bien frais.');
  await editor.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByTestId('ai-review-status')).toHaveText('Draft');

  // An invented price is saved (it is the merchant's draft) but flagged, and cannot be approved.
  await editor.getByLabel('Caption / text').fill('Notre jus de bissap à seulement 999 XAF aujourd’hui !');
  await editor.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByTestId('ai-quality')).toHaveAttribute('data-passed', 'false');
  await expect(page.getByTestId('ai-quality')).toContainText('999 XAF');
  await review.getByRole('button', { name: 'Submit for review' }).click();
  await review.getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByTestId('ai-review-error')).toContainText('This text cannot be approved yet');
  await expect(page.getByTestId('ai-review-error')).toContainText('999 XAF');
  await expect(page.getByTestId('ai-review-status')).toHaveText('In review');

  // Reject with a reason, then fix the text and go through the review again.
  await review.getByRole('button', { name: 'Reject', exact: true }).click();
  await page.getByLabel('Reason for rejection').fill('Remove the price, it is not verified');
  await review.getByRole('button', { name: 'Reject draft' }).click();
  await expect(page.getByTestId('ai-review-status')).toHaveText('Rejected');
  await expect(review).toContainText('Remove the price, it is not verified');
  await editor.getByLabel('Caption / text').fill('Notre jus de bissap, 1 500 XAF, servi bien frais.');
  await editor.getByRole('button', { name: 'Save draft' }).click();
  await review.getByRole('button', { name: 'Submit for review' }).click();
  await review.getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByTestId('ai-review-status')).toHaveText('Approved');
});

test('usage page: monthly report with completed generations, tokens and cost', async ({ page }) => {
  await setup(page);
  await page.goto('/dashboard/ai/business-analysis');
  await page.getByRole('button', { name: 'Generate', exact: true }).click();
  await expect(page.getByTestId('business-analysis')).toContainText('Target segments');
  await page.goto('/dashboard/ai');
  const monthly = page.getByTestId('usage-monthly');
  await expect(monthly).toContainText('Monthly usage');
  const month = new Date().toISOString().slice(0, 7);
  const row = monthly.getByTestId(`usage-month-${month}`);
  await expect(row).toBeVisible();
  await expect(row.locator('td').nth(1)).toHaveText('1'); // one completed generation
  await expect(row.locator('td').nth(6)).toContainText('$'); // priced with the configured model table
  await expect(monthly).toContainText('gpt-4o-mini');
  await expect(page.getByTestId('ai-month-usage')).toContainText('1 /');
});
