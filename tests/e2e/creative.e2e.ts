import { createRequire } from 'module';
import { resolve } from 'path';
import { expect, test, type Page } from '@playwright/test';

/**
 * Full-stack Creative Studio flows. The API runs with the TEST-ONLY deterministic image/video providers:
 * these tests prove the product workflow (jobs, storage, limits, UI); they say nothing about real providers.
 */
const sharp = createRequire(resolve(__dirname, '../../apps/api/package.json'))('sharp') as typeof import('sharp');

/** A product on a plain white background: what EXACT mode needs to cut the product out. */
async function studioPhoto() {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600"><rect width="600" height="600" fill="#ffffff"/><rect x="190" y="120" width="220" height="360" rx="40" fill="#b3261e"/><rect x="250" y="70" width="100" height="70" rx="12" fill="#333333"/></svg>';
  return sharp(Buffer.from(svg)).png().toBuffer();
}

async function setup(page: Page) {
  await page.goto('/register');
  await page.getByLabel('Full name').fill('Awa Mahamat');
  await page.getByLabel('Email').fill(`cr${Date.now()}${Math.floor(Math.random() * 1e6)}@example.com`);
  await page.getByLabel('Password').fill('Correct-Horse-9-Battery');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByLabel('Business name').fill('Maquis Awa');
  await page.getByLabel('Business type').selectOption('RESTAURANT');
  await page.getByLabel('Currency').selectOption('XAF');
  await page.getByRole('button', { name: 'Create my business' }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
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
  });
}

test('overview shows providers, usage and quick links', async ({ page }) => {
  await setup(page);
  await page.getByRole('navigation', { name: 'Menu' }).getByRole('link', { name: 'Creative Studio' }).click();
  await expect(page).toHaveURL(/\/dashboard\/creative$/);
  await expect(page.getByTestId('creative-providers')).toContainText('Image provider');
  await expect(page.getByTestId('creative-providers')).toContainText('Configured');
  await expect(page.getByTestId('creative-usage-card')).toContainText('Images');
  await expect(page.getByRole('navigation', { name: 'Creative Studio' }).getByRole('link')).toHaveCount(6);
});

test('image studio: generate variations, favorite and download', async ({ page }) => {
  await setup(page);
  await page.goto('/dashboard/creative/images');
  await page.getByLabel('Variations').selectOption('2');
  await page.getByLabel('Text on the image').fill('Fresh every day');
  await page.getByRole('button', { name: 'Generate' }).click();
  const results = page.getByTestId('creative-results');
  await expect(results).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('creative-output')).toHaveCount(2);
  await expect(results).toContainText('Illustration'); // no photo: never presented as the real product
  await page.getByRole('button', { name: 'Favorite' }).nth(1).click();
  await expect(page.getByTestId('creative-output').nth(1)).toHaveAttribute('data-selected', 'true');
  await expect(page.getByRole('link', { name: 'Download' }).first()).toHaveAttribute('href', /download=1/);
});

test('product photo in EXACT mode keeps the real product and offers a comparison', async ({ page }) => {
  await setup(page);
  await page.goto('/dashboard/creative/images');
  await page.getByRole('button', { name: 'Choose a photo' }).click();
  const picker = page.getByRole('dialog');
  await picker.getByTestId('media-file-input').setInputFiles({ name: 'bottle.png', mimeType: 'image/png', buffer: await studioPhoto() });
  await picker.getByRole('button', { name: 'Use selected (1)' }).click({ timeout: 20_000 });
  await expect(page.getByTestId('source-photo')).toContainText('bottle.png');
  await expect(page.getByRole('radio', { name: /Exact/ })).toBeChecked();
  await page.getByRole('button', { name: 'Generate' }).click();
  await expect(page.getByTestId('creative-results')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('creative-results')).toContainText('Original product preserved');
  await page.getByRole('checkbox', { name: 'Select image 1' }).check();
  await page.getByTestId('compare-open').click();
  await expect(page.getByTestId('compare-view')).toBeVisible();
  await expect(page.getByTestId('compare-view')).toContainText('Original photo');
});

test('guided mode warns that the product may differ', async ({ page }) => {
  await setup(page);
  await page.goto('/dashboard/creative/images');
  await page.getByRole('button', { name: 'Choose a photo' }).click();
  const picker = page.getByRole('dialog');
  await picker.getByTestId('media-file-input').setInputFiles({ name: 'bottle.png', mimeType: 'image/png', buffer: await studioPhoto() });
  await picker.getByRole('button', { name: 'Use selected (1)' }).click({ timeout: 20_000 });
  await page.getByRole('radio', { name: /Guided/ }).check();
  await page.getByRole('button', { name: 'Generate' }).click();
  await expect(page.getByTestId('creative-results')).toContainText('Guided', { timeout: 30_000 });
  await page.getByRole('checkbox', { name: 'Select image 1' }).check();
  await page.getByTestId('compare-open').click();
  await expect(page.getByRole('dialog').filter({ has: page.getByTestId('compare-view') })).toContainText('may differ slightly');
});

test('brand kit: save colors and tone, preview updates, persists on reload', async ({ page }) => {
  await setup(page);
  await page.goto('/dashboard/creative/brand-kit');
  await page.getByRole('button', { name: 'Add a color' }).click();
  await page.getByLabel('Color name').first().fill('Hibiscus');
  await page.getByLabel('Hex code').first().fill('#B3261E');
  await page.getByLabel('Preferred tone').selectOption('FRIENDLY');
  await page.getByLabel('Visual style').selectOption('NATURAL');
  await page.getByLabel('Guidelines').fill('Always show the product\nNo stock people');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Brand kit saved')).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Color name').first()).toHaveValue('Hibiscus');
  await expect(page.getByLabel('Preferred tone')).toHaveValue('FRIENDLY');
  await expect(page.getByLabel('Visual style')).toHaveValue('NATURAL');
  await expect(page.getByTestId('brand-preview')).toBeVisible();
  await page.getByLabel('Hex code').first().fill('nope');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Use a code like #1A7F5A.')).toBeVisible();
});

test('storyboard then video: scenes grounded, video generated by the (test) provider', async ({ page }) => {
  await setup(page);
  await page.goto('/dashboard/creative/storyboards');
  await page.getByRole('button', { name: 'Create storyboard' }).click();
  await expect(page.getByTestId('storyboard-view')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('storyboard-scene').first()).toBeVisible();
  await expect(page.getByTestId('storyboard-timeline')).toBeVisible();
  await page.getByRole('link', { name: 'Make a video' }).click();
  await expect(page).toHaveURL(/\/dashboard\/creative\/videos\?storyboard=/);
  await page.getByRole('button', { name: 'Generate video' }).click();
  await expect(page.getByTestId('video-result')).toBeVisible({ timeout: 45_000 });
  await expect(page.getByTestId('video-player')).toBeVisible();
});

test('history lists creations, shows details and deletes one', async ({ page }) => {
  await setup(page);
  await page.goto('/dashboard/creative/images');
  await page.getByRole('button', { name: 'Generate' }).click();
  await expect(page.getByTestId('creative-results')).toBeVisible({ timeout: 30_000 });
  await page.goto('/dashboard/creative/history');
  const list = page.getByTestId('creative-history');
  await expect(list.getByRole('button').first()).toBeVisible();
  await list.getByRole('button').first().click();
  const detail = page.getByTestId('creative-detail');
  await expect(detail).toContainText('Provider');
  await detail.getByRole('button', { name: 'Delete' }).click();
  await page.getByRole('dialog', { name: 'Delete this generation?' }).getByRole('button', { name: 'Delete' }).click();
  await expect(page.getByText('Nothing here yet')).toBeVisible();
});

test.describe('mobile (390×844)', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  const pages = ['', '/images', '/videos', '/storyboards', '/brand-kit', '/history'];

  test('every creative page fits the screen without horizontal scrolling', async ({ page }) => {
    await setup(page);
    for (const p of pages) {
      await page.goto(`/dashboard/creative${p}`);
      await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, `horizontal overflow on /dashboard/creative${p}`).toBeLessThanOrEqual(1);
    }
  });

  test('the image form is usable on a phone: generate and see results', async ({ page }) => {
    await setup(page);
    await page.goto('/dashboard/creative/images');
    const generate = page.getByRole('button', { name: 'Generate' });
    await generate.scrollIntoViewIfNeeded();
    await expect(generate).toBeVisible();
    const box = await generate.boundingBox();
    expect(box!.width).toBeGreaterThan(80);
    expect(box!.height).toBeGreaterThanOrEqual(36); // comfortable tap target
    await generate.click();
    await expect(page.getByTestId('creative-results')).toBeVisible({ timeout: 30_000 });
    const out = await page.getByTestId('creative-output').first().boundingBox();
    expect(out!.x + out!.width).toBeLessThanOrEqual(390 + 1);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  });
});
