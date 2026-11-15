import { expect, test, type Page } from '@playwright/test';

/** N29 Campaign Control Center, in the free test mode: `E2E_CREATIVE_MODE=mock pnpm test:web-e2e`. Everything is simulated; nothing is published or billed. */
test.skip(process.env.E2E_CREATIVE_MODE !== 'mock', 'needs the free test mode (E2E_CREATIVE_MODE=mock)');

async function setup(page: Page, tag: string) {
  await page.goto('/register');
  await page.getByLabel('Full name').fill(`Owner ${tag}`);
  await page.getByLabel('Email').fill(`cp${tag}${Date.now()}${Math.floor(Math.random() * 1e6)}@example.com`);
  await page.getByLabel('Password').fill('Correct-Horse-9-Battery');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByLabel('Business name').fill(`Business ${tag}`);
  await page.getByLabel('Business type').selectOption('RESTAURANT');
  await page.getByLabel('Currency').selectOption('XAF');
  await page.getByRole('button', { name: 'Create my business' }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
}

async function fill(page: Page, name: string, mode: 'AUTO' | 'HYBRID', photos: number, videos: number, startLocal: string) {
  await page.getByLabel('Campaign name').fill(name);
  await page.getByLabel('Product or service').fill('Fresh bissap juice');
  await page.getByLabel('Marketing objective').fill('Sell more juice this weekend');
  await page.getByLabel('Target audience').fill('Students');
  await page.getByLabel('Number of photos').fill(String(photos));
  await page.getByLabel('Number of videos').fill(String(videos));
  await page.getByLabel('First post').fill(startLocal);
  await page.getByTestId(`mode-${mode}`).check();
  await page.getByTestId('campaign-create').click();
}
const tomorrow = (hh: string) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + 2); return `${d.toISOString().slice(0, 10)}T${hh}`; };

test('client A (AUTO): the campaign runs, every agent finishes, posts are scheduled fictitiously and previewable', async ({ page }) => {
  await setup(page, 'A');
  await page.goto('/dashboard/creative/campaigns');
  await expect(page.getByTestId('simulation-banner')).toContainText('SIMULATION MODE');
  await fill(page, 'A launch', 'AUTO', 3, 2, tomorrow('10:00'));
  await expect(page.getByTestId('campaign-detail')).toContainText('A launch');
  await page.getByTestId('campaign-start').click();
  await expect(page.getByTestId('detail-status')).toHaveText('Completed', { timeout: 60_000 });
  await expect(page.getByTestId('campaign-tasks').locator('li[data-status="SUCCEEDED"]')).toHaveCount(9);
  await expect(page.getByTestId('campaign-post')).toHaveCount(5);
  await expect(page.getByTestId('campaign-post').first().getByTestId('post-media')).toHaveAttribute('data-simulated', 'true');
  await expect(page.getByTestId('stat-photos')).toContainText('3');
  await expect(page.getByTestId('stat-videos')).toContainText('2');
  await expect(page.getByTestId('quota-images-count')).toContainText('3/5');
  await expect(page.getByTestId('quota-videos-count')).toContainText('2/5');
  await page.getByTestId('simulate-due').click();
  await expect(page.getByTestId('campaign-post').first()).toHaveAttribute('data-status', 'SIMULATED_PUBLISHED');
});

test('client B (HYBRID): a post waits for approval; approving it completes the campaign; a stop can be undone', async ({ page }) => {
  await setup(page, 'B');
  await page.goto('/dashboard/creative/campaigns');
  await fill(page, 'B launch', 'HYBRID', 2, 2, tomorrow('03:00'));
  await page.getByTestId('campaign-start').click();
  await expect(page.getByTestId('detail-status')).toHaveText('Awaiting approval', { timeout: 60_000 });
  const waiting = page.locator('[data-testid="campaign-post"][data-status="PENDING_APPROVAL"]');
  await expect(waiting.first()).toBeVisible();
  await expect(page.getByTestId('waiting-approval')).toContainText('B launch');
  // Emergency stop, then resume: the approval state is never carried over.
  await page.getByTestId('campaign-stop').click();
  await expect(page.getByTestId('detail-status')).toHaveText('Stopped');
  await page.getByTestId('campaign-resume').click();
  await expect(page.getByTestId('detail-status')).toHaveText('Awaiting approval', { timeout: 30_000 });
  while (await waiting.count()) { const before = await waiting.count(); await waiting.first().getByTestId('post-approve').click(); await expect(waiting).toHaveCount(before - 1); }
  await expect(page.getByTestId('detail-status')).toHaveText('Completed');
  await expect(page.getByTestId('error-history')).toContainText('No error.');
  await page.setViewportSize({ width: 375, height: 800 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
});
