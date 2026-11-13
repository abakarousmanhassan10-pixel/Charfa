import { expect, test, type Page } from '@playwright/test';
import { png } from '../../apps/api/test/fixtures';

/**
 * Social media dashboard flows. The API runs with the TEST-ONLY platform simulator: the platform's sign-in screen is simulated by
 * intercepting the redirect to the platform and sending the browser back to TOUMA's real OAuth callback. These tests prove TOUMA's
 * behavior, not that any real platform accepts a connection or a post.
 */
async function setup(page: Page) {
  await page.goto('/register');
  await page.getByLabel('Full name').fill('Awa Mahamat');
  await page.getByLabel('Email').fill(`soc${Date.now()}${Math.floor(Math.random() * 1e6)}@example.com`);
  await page.getByLabel('Password').fill('Correct-Horse-9-Battery');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByLabel('Business name').fill('Maquis Awa');
  await page.getByLabel('Business type').selectOption('RESTAURANT');
  await page.getByLabel('Currency').selectOption('XAF');
  await page.getByRole('button', { name: 'Create my business' }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
}

/** The simulated platform sign-in: whatever the simulator's authorize URL is, "approve" or "deny" it and come back to TOUMA. */
async function simulatePlatform(page: Page, outcome: 'approve' | 'deny' = 'approve') {
  await page.route('https://fake-platform.test/**', async (route) => {
    const url = new URL(route.request().url());
    const platform = url.pathname.split('/')[1]!.toLowerCase();
    const state = url.searchParams.get('state')!;
    const back = new URL(`http://localhost:3100/api/v1/social/oauth/callback/${platform}`);
    if (outcome === 'approve') back.searchParams.set('code', 'valid-code');
    else back.searchParams.set('error', 'access_denied');
    back.searchParams.set('state', state);
    await route.fulfill({ status: 302, headers: { location: back.toString() } });
  });
}

async function connect(page: Page, platform: string, pick = 'first') {
  await page.goto('/dashboard/social/accounts');
  await page.locator(`[data-testid="platform-card"][data-platform="${platform}"]`).getByTestId('connect-button').click();
  const dialog = page.getByTestId('select-dialog');
  await expect(dialog).toBeVisible({ timeout: 20_000 });
  const boxes = dialog.getByTestId('candidate');
  await expect(boxes.first()).not.toBeChecked(); // the person chooses: nothing is pre-selected
  if (pick === 'first') await boxes.first().check();
  else await boxes.nth(Number(pick)).check();
  await dialog.getByTestId('select-confirm').click();
  await expect(page.locator(`[data-testid="account-item"][data-platform="${platform}"][data-status="CONNECTED"]`).first()).toBeVisible();
}

/** Writes a post in the composer and takes it through approval to "publish now". */
async function publishNow(page: Page, p: { platform: string; title: string; caption: string; kind?: string; media?: boolean }) {
  await page.goto('/dashboard/social/publishing');
  const form = page.getByTestId('composer');
  await form.getByLabel('Platform').selectOption(p.platform);
  if (p.kind) await form.getByLabel('Type').selectOption(p.kind);
  await form.getByLabel('Title').fill(p.title);
  await form.getByLabel('Caption').fill(p.caption);
  if (p.media) {
    await form.getByTestId('add-media').click();
    const picker = page.getByRole('dialog', { name: 'Choose media' });
    await picker.getByTestId('media-file-input').setInputFiles({ name: 'photo.png', mimeType: 'image/png', buffer: png(60, 60) });
    await picker.getByRole('button', { name: 'Use selected (1)' }).click({ timeout: 20_000 });
  }
  await form.getByTestId('save-draft').click();
  await expect(page.getByTestId('publishing-message')).toContainText('Saved as a draft');
  const row = page.locator('[data-testid="pipeline-item"]', { hasText: p.title });
  await row.getByTestId('pipe-submit').click();
  await expect(row).toHaveAttribute('data-status', 'IN_REVIEW');
  await row.getByTestId('pipe-approve').click();
  await expect(row).toHaveAttribute('data-status', 'APPROVED');
  await row.getByTestId('pipe-publish-now').click();
  const dialog = page.getByTestId('publish-now-dialog');
  await expect(dialog.getByTestId('now-confirm')).toBeDisabled(); // explicit authorization first
  await dialog.getByTestId('now-authorize').check();
  await dialog.getByTestId('now-confirm').click();
  await expect(page.getByTestId('publishing-message')).toContainText('Handed to the publisher');
}

test('overview and settings show the platforms, the permissions and the honest limits', async ({ page }) => {
  await setup(page);
  await page.getByRole('navigation', { name: 'Menu' }).getByRole('link', { name: 'Social media' }).click();
  await expect(page).toHaveURL(/\/dashboard\/social$/);
  await expect(page.getByTestId('stat-connected')).toHaveText('0');
  await expect(page.getByRole('navigation', { name: 'Social media' }).getByRole('link')).toHaveCount(6);
  await expect(page.getByTestId('publishing-unavailable')).toHaveCount(0); // the simulator is configured
  await page.goto('/dashboard/social/settings');
  await expect(page.getByTestId('fake-mode')).toContainText('test-only platform simulator');
  await expect(page.getByTestId('settings-platform')).toHaveCount(5);
  const tiktok = page.locator('[data-testid="settings-platform"][data-platform="TIKTOK"]');
  await expect(tiktok).toContainText('Permissions requested');
  await expect(tiktok.getByTestId('restrictions')).toContainText('private to the creator');
  await expect(page.locator('[data-testid="settings-platform"][data-platform="INSTAGRAM"]')).toContainText('/api/v1/social/oauth/callback/instagram');
  await expect(page.locator('[data-testid="settings-platform"][data-platform="INSTAGRAM"]').getByTestId('restrictions')).toContainText('manual publishing');
});

test('connect an account through OAuth with account selection, then disconnect it', async ({ page }) => {
  await setup(page);
  await simulatePlatform(page);
  await page.goto('/dashboard/social/accounts');
  await expect(page.getByTestId('no-passwords')).toContainText('never asks for or stores your social media passwords');
  await expect(page.getByTestId('account-item')).toHaveCount(0);
  await page.locator('[data-testid="platform-card"][data-platform="FACEBOOK"]').getByTestId('connect-button').click();
  const dialog = page.getByTestId('select-dialog');
  await expect(dialog).toBeVisible({ timeout: 20_000 });
  await expect(dialog.getByTestId('candidate')).toHaveCount(2); // the platform offered two accounts: the person chooses
  await expect(page.getByTestId('account-item')).toHaveCount(0); // nothing is connected until the person selects
  await dialog.getByTestId('candidate').nth(1).check();
  await dialog.getByTestId('select-confirm').click();
  const account = page.locator('[data-testid="account-item"][data-platform="FACEBOOK"]');
  await expect(account).toHaveCount(1);
  await expect(account).toHaveAttribute('data-status', 'CONNECTED');
  await expect(account).toContainText('Facebook Page');
  await expect(account).toContainText('does not expire');
  await expect(page).toHaveURL(/\/dashboard\/social\/accounts$/); // the one-time connection id is gone from the address
  await page.reload();
  await expect(account).toHaveCount(1);
  // The browser never sees a token.
  const html = await page.content();
  expect(html).not.toMatch(/FACEBOOK-token|accessToken/);

  await account.getByTestId('disconnect-button').click();
  await page.getByRole('dialog').getByRole('button', { name: 'Disconnect' }).click();
  await expect(account).toHaveAttribute('data-status', 'DISCONNECTED');
  await expect(account.getByTestId('reconnect-button')).toBeVisible();
});

test('a platform that refuses the connection connects nothing and says so', async ({ page }) => {
  await setup(page);
  await simulatePlatform(page, 'deny');
  await page.goto('/dashboard/social/accounts');
  await page.locator('[data-testid="platform-card"][data-platform="YOUTUBE"]').getByTestId('connect-button').click();
  await expect(page.getByTestId('oauth-error')).toContainText('cancelled on the platform', { timeout: 20_000 });
  await expect(page.getByTestId('account-item')).toHaveCount(0);
  // An old or forged link does nothing either.
  await page.goto('/dashboard/social/accounts?connect=nonexistentconnection000');
  await expect(page.getByTestId('select-dialog')).toHaveCount(0);
});

test('publish a text post: approval, explicit authorization, then the platform confirms it', async ({ page }) => {
  await setup(page);
  await simulatePlatform(page);
  await connect(page, 'FACEBOOK');
  await publishNow(page, { platform: 'FACEBOOK', title: 'Bissap Friday', caption: 'Fresh bissap juice, served cold.' });
  await page.goto('/dashboard/social/history');
  const row = page.locator('[data-testid="publication-item"]', { hasText: 'Bissap Friday' });
  await expect(row).toHaveAttribute('data-status', 'PUBLISHED', { timeout: 30_000 });
  await expect(row.getByTestId('external-link')).toHaveAttribute('href', /^https:\/\/fake-platform\.test\/FACEBOOK\//);
  await expect(row.getByTestId('manual-badge')).toHaveCount(0); // confirmed by the platform
  // Metrics: a real zero is shown as 0, what the platform did not provide is shown as unavailable.
  await row.getByTestId('metrics-button').click();
  const dialog = page.getByTestId('metrics-dialog');
  await dialog.getByRole('button', { name: 'Refresh now' }).click(); // read them now instead of waiting for the background collection
  await expect(dialog.locator('[data-metric="likes"]')).toContainText('0');
  await expect(dialog.locator('[data-metric="likes"]')).toHaveAttribute('data-available', 'true');
  await expect(dialog.locator('[data-metric="comments"]')).toContainText('2');
  await expect(dialog.locator('[data-metric="views"]')).toHaveAttribute('data-available', 'false');
  await expect(dialog.locator('[data-metric="views"]')).toContainText('Not provided by the platform');
  await expect(dialog.locator('[data-metric="engagement"]')).toHaveAttribute('data-available', 'false');
  await page.keyboard.press('Escape');
  await page.goto('/dashboard/social');
  await expect(page.getByTestId('stat-published')).toHaveText('1');
  await page.getByTestId('filter-INSTAGRAM').click();
  await expect(page.getByTestId('recent-publications')).toHaveCount(0);
});

test('a format the API cannot publish goes to manual publishing, and is never shown as published by the platform', async ({ page }) => {
  await setup(page);
  await simulatePlatform(page);
  await connect(page, 'INSTAGRAM');
  await page.goto('/dashboard/social/publishing');
  await page.getByTestId('composer').getByLabel('Type').selectOption('TEXT');
  await expect(page.getByTestId('manual-warning')).toContainText('cannot publish Text posts through its official API');
  await publishNow(page, { platform: 'INSTAGRAM', title: 'Text on Instagram', caption: 'A text only post for Instagram.' });
  await page.goto('/dashboard/social/queue');
  const row = page.locator('[data-testid="publication-item"]', { hasText: 'Text on Instagram' });
  await expect(row).toHaveAttribute('data-status', 'MANUAL_REQUIRED', { timeout: 30_000 });
  await expect(row.getByTestId('publication-message')).toContainText('manually');
  await row.getByTestId('manual-button').click();
  const dialog = page.getByTestId('manual-dialog');
  await expect(dialog.getByTestId('manual-text')).toContainText('A text only post for Instagram.');
  await expect(dialog.getByTestId('manual-submit')).toBeDisabled();
  await dialog.getByTestId('manual-confirm').check();
  await dialog.getByTestId('manual-submit').click();
  await page.goto('/dashboard/social/history');
  const done = page.locator('[data-testid="publication-item"]', { hasText: 'Text on Instagram' });
  await expect(done).toHaveAttribute('data-status', 'PUBLISHED');
  await expect(done.getByTestId('manual-badge')).toBeVisible();
  await expect(done).toContainText('not confirmed by the platform');
  await expect(done.getByTestId('metrics-button')).toBeVisible();
  await done.getByTestId('metrics-button').click();
  await expect(page.getByTestId('metrics-dialog')).toContainText('published manually');
});

test('a publication the platform rules reject fails with a clear message and nothing is sent', async ({ page }) => {
  await setup(page);
  await simulatePlatform(page);
  await connect(page, 'INSTAGRAM');
  // Instagram only accepts JPEG images: a PNG is refused by TOUMA before anything is sent.
  await publishNow(page, { platform: 'INSTAGRAM', title: 'PNG on Instagram', caption: 'Photo caption', kind: 'IMAGE', media: true });
  await page.goto('/dashboard/social/history?status=FAILED');
  const row = page.locator('[data-testid="publication-item"]', { hasText: 'PNG on Instagram' });
  await expect(row).toHaveAttribute('data-status', 'FAILED', { timeout: 30_000 });
  await expect(row.getByTestId('publication-message')).toContainText('image types');
  await expect(row.getByTestId('retry-button')).toBeVisible();
  await expect(row.getByTestId('external-link')).toHaveCount(0);
  await page.goto('/dashboard/calendar');
  await expect(page.getByTestId('stat-problems')).not.toHaveText('0');
});

test('LinkedIn: personal profile connects; organization publishing is shown as disabled until LinkedIn approves it', async ({ page }) => {
  await setup(page);
  await simulatePlatform(page);
  await page.goto('/dashboard/social/accounts');
  const card = page.locator('[data-testid="platform-card"][data-platform="LINKEDIN"]');
  const org = card.locator('[data-testid="variant"][data-variant="organization"]');
  await expect(org).toHaveAttribute('data-enabled', 'false');
  await expect(org.getByTestId('variant-disabled')).toContainText('LinkedIn must first approve the TOUMA application');
  await expect(org.getByTestId('connect-button')).toHaveCount(0); // no way to start an organization connection
  await expect(card.locator('[data-testid="variant"][data-variant="personal"]').getByTestId('connect-button')).toBeVisible();
  await connect(page, 'LINKEDIN');
  await expect(page.locator('[data-testid="account-item"][data-platform="LINKEDIN"][data-status="CONNECTED"]').first()).toBeVisible();
});

test.describe('TikTok posting screen (audit readiness)', () => {
  async function openComposer(page: Page) {
    await setup(page);
    await simulatePlatform(page);
    await connect(page, 'TIKTOK');
    await page.goto('/dashboard/social/publishing');
    const form = page.getByTestId('composer');
    await form.getByLabel('Platform').selectOption('TIKTOK');
    await form.getByLabel('Type').selectOption('IMAGE');
    await form.getByLabel('Title').fill('Bissap on TikTok');
    await form.getByLabel('Caption').fill('Cold bissap, fresh today.');
    await form.getByTestId('add-media').click();
    const picker = page.getByRole('dialog', { name: 'Choose media' });
    await picker.getByTestId('media-file-input').setInputFiles({ name: 'photo.png', mimeType: 'image/png', buffer: png(60, 60) });
    await picker.getByRole('button', { name: 'Use selected (1)' }).click({ timeout: 20_000 });
    return { form, panel: page.getByTestId('tiktok-panel') };
  }

  test('shows creator information, preview, and pre-selects nothing; saving needs every required choice', async ({ page }) => {
    const { form, panel } = await openComposer(page);
    await expect(panel.getByTestId('tiktok-nickname')).toHaveText('Test Creator'); // read live from TikTok (simulated here)
    await expect(panel.getByTestId('tiktok-preview').locator('img')).toBeVisible();
    // Nothing is chosen for the creator.
    await expect(panel.getByTestId('tiktok-privacy')).toHaveValue('');
    await expect(panel.getByTestId('tiktok-comment')).not.toBeChecked();
    await expect(panel.getByTestId('tiktok-duet')).toHaveCount(0); // Duet and Stitch exist for videos only, not for photo posts
    await expect(panel.getByTestId('tiktok-stitch')).toHaveCount(0);
    await expect(panel.getByTestId('tiktok-commercial')).not.toBeChecked();
    await expect(panel.getByTestId('tiktok-consent')).not.toBeChecked();
    await expect(form.getByTestId('save-draft')).toBeDisabled();
    await expect(panel.getByTestId('tiktok-missing')).toContainText('Choose who can view');
    // The privacy options are the ones the account offers.
    await expect(panel.getByTestId('tiktok-privacy').locator('option')).toHaveText(['Choose who can view…', 'Everyone', 'Followers', 'Only me']);
    await panel.getByTestId('tiktok-privacy').selectOption('PUBLIC_TO_EVERYONE');
    await expect(form.getByTestId('save-draft')).toBeDisabled(); // consent still missing
    await panel.getByTestId('tiktok-consent').check();
    await expect(form.getByTestId('save-draft')).toBeEnabled();
  });

  test('commercial content disclosure: needs a type, shows the label, and branded content cannot be private', async ({ page }) => {
    const { form, panel } = await openComposer(page);
    await panel.getByTestId('tiktok-privacy').selectOption('SELF_ONLY');
    await panel.getByTestId('tiktok-consent').check();
    await panel.getByTestId('tiktok-commercial').check();
    await expect(panel.getByTestId('tiktok-disclosure-incomplete')).toBeVisible();
    await expect(form.getByTestId('save-draft')).toBeDisabled();
    await expect(panel.getByTestId('tiktok-branded')).toBeDisabled(); // private visibility + branded content is not allowed
    await panel.getByTestId('tiktok-your-brand').check();
    await expect(panel.getByTestId('tiktok-label')).toContainText('Promotional content');
    await expect(form.getByTestId('save-draft')).toBeEnabled();
    await panel.getByTestId('tiktok-privacy').selectOption('FOLLOWER_OF_CREATOR');
    await panel.getByTestId('tiktok-branded').check();
    await expect(panel.getByTestId('tiktok-label')).toContainText('Paid partnership');
    await expect(panel.getByTestId('tiktok-consent')).toBeChecked();
    await expect(panel.locator('[data-testid="tiktok-consent"] + span')).toContainText('Branded Content Policy');
    // While branded content is selected, "Only me" cannot be chosen; unchecking it makes the option available again.
    await expect(panel.getByTestId('tiktok-privacy').locator('option[value="SELF_ONLY"]')).toBeDisabled();
    await expect(panel.getByTestId('tiktok-branded-private')).toBeVisible();
    await panel.getByTestId('tiktok-branded').uncheck();
    await expect(panel.getByTestId('tiktok-privacy').locator('option[value="SELF_ONLY"]')).toBeEnabled();
  });

  test('saved choices gate review; the final confirmation shows them; changing them withdraws approval', async ({ page }) => {
    const { form, panel } = await openComposer(page);
    await panel.getByTestId('tiktok-privacy').selectOption('FOLLOWER_OF_CREATOR');
    await panel.getByTestId('tiktok-comment').check();
    await panel.getByTestId('tiktok-consent').check();
    await form.getByTestId('save-draft').click();
    await expect(page.getByTestId('publishing-message')).toContainText('Saved as a draft');
    const row = page.locator('[data-testid="pipeline-item"]', { hasText: 'Bissap on TikTok' });
    await row.getByTestId('pipe-submit').click();
    await expect(row).toHaveAttribute('data-status', 'IN_REVIEW');
    await row.getByTestId('pipe-approve').click();
    await expect(row).toHaveAttribute('data-status', 'APPROVED');
    await row.getByTestId('pipe-publish-now').click();
    const dialog = page.getByTestId('publish-now-dialog');
    await expect(dialog.getByTestId('tiktok-summary-privacy')).toHaveText('Followers');
    await expect(dialog.getByTestId('tiktok-summary-label')).toHaveText('No commercial content');
    await expect(dialog).toContainText('I confirm the TikTok settings above');
    await expect(dialog).toContainText('a few minutes');
    await expect(dialog.getByTestId('now-confirm')).toBeDisabled();
    await page.keyboard.press('Escape');
    // Editing the settings changes the content: approval is withdrawn and it must be approved again.
    await row.getByTestId('pipe-tiktok').click();
    const settings = page.getByTestId('tiktok-settings-dialog');
    await expect(settings.getByTestId('tiktok-privacy')).toHaveValue('FOLLOWER_OF_CREATOR');
    await settings.getByTestId('tiktok-privacy').selectOption('SELF_ONLY');
    await settings.getByTestId('tiktok-save').click();
    await expect(row).toHaveAttribute('data-status', 'IN_REVIEW');
  });
});

test('accounts whose token can be renewed offer a renew action; the list shows how long authorizations last', async ({ page }) => {
  await setup(page);
  await simulatePlatform(page);
  await connect(page, 'TIKTOK');
  const account = page.locator('[data-testid="account-item"][data-platform="TIKTOK"]');
  await expect(account).toHaveCount(1);
  await expect(account).toContainText('Authorization:');
  await expect(account.getByTestId('refresh-button')).toBeVisible(); // TikTok tokens can be renewed
  await account.getByTestId('refresh-button').click();
  await expect(account).toHaveAttribute('data-status', 'CONNECTED');
});

test.describe('mobile (390×844)', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('every social page fits the screen without horizontal scrolling', async ({ page }) => {
    await setup(page);
    await simulatePlatform(page);
    await connect(page, 'FACEBOOK');
    await publishNow(page, { platform: 'FACEBOOK', title: 'A rather long post title to test how the phone layout wraps text', caption: 'Fresh bissap juice, served cold.' });
    for (const p of ['', '/accounts', '/publishing', '/queue', '/history', '/settings']) {
      await page.goto(`/dashboard/social${p}`);
      await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
      await page.waitForLoadState('networkidle');
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, `horizontal overflow on /dashboard/social${p}`).toBeLessThanOrEqual(1);
    }
  });

  test('connecting an account and composing a post work on a phone', async ({ page }) => {
    await setup(page);
    await simulatePlatform(page);
    await connect(page, 'LINKEDIN');
    await page.goto('/dashboard/social/publishing');
    const form = page.getByTestId('composer');
    await form.getByLabel('Title').fill('From my phone');
    await form.getByLabel('Caption').fill('Hello from a phone.');
    await form.getByTestId('save-draft').scrollIntoViewIfNeeded();
    const box = await form.getByTestId('save-draft').boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(36);
    await form.getByTestId('save-draft').click();
    await expect(page.locator('[data-testid="pipeline-item"]', { hasText: 'From my phone' })).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  });
});
