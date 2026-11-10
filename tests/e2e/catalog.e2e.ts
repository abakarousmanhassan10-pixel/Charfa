import { expect, test, type Page } from '@playwright/test';
import { png } from '../../apps/api/test/fixtures';

const password = 'Correct-Horse-9-Battery';

async function setup(page: Page, businessName = 'Maquis Awa') {
  await page.goto('/register');
  await page.getByLabel('Full name').fill('Awa Mahamat');
  await page.getByLabel('Email').fill(`cat${Date.now()}${Math.floor(Math.random() * 1e6)}@example.com`);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL(/\/onboarding$/);
  await page.getByLabel('Business name').fill(businessName);
  await page.getByLabel('Business type').selectOption('RESTAURANT');
  await page.getByLabel('Currency').selectOption('XAF');
  await page.getByRole('button', { name: 'Create my business' }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
}

const image = (name: string, w = 40, h = 40) => ({ name, mimeType: 'image/png', buffer: png(w, h) });

test('product lifecycle: create with photo, price and category, search, edit, delete', async ({ page }) => {
  await setup(page);
  await page.getByRole('link', { name: 'Products' }).first().click();
  await expect(page.getByText('No products yet.')).toBeVisible();
  await page.getByRole('link', { name: 'New product' }).first().click();
  await expect(page.getByRole('heading', { name: 'New product' })).toBeVisible();

  await page.getByLabel('Name', { exact: true }).fill('Grilled chicken');
  await page.getByLabel('Description (optional)').fill('Marinated in ginger and lemon, served with fries.');
  await page.getByLabel('Category (optional)').selectOption({ label: 'Main dishes' });
  await page.getByLabel('Status').selectOption('ACTIVE');
  await page.getByLabel('Price (optional)', { exact: true }).fill('5000');
  await page.getByLabel('Discount price (optional)').fill('6000');
  await page.getByLabel('Features (optional)').fill('Halal\nSpicy option');
  await page.getByRole('button', { name: 'Create product' }).click();
  // Client-side validation mirrors the API rule.
  await expect(page.getByText('Discount price must be lower than the price')).toBeVisible();
  await page.getByLabel('Discount price (optional)').fill('4500');

  await page.getByRole('button', { name: 'Add media' }).click();
  const picker = page.getByRole('dialog', { name: 'Choose media' });
  await picker.getByTestId('media-file-input').setInputFiles(image('chicken.png'));
  await expect(picker.getByRole('button', { name: 'Use selected (1)' })).toBeVisible();
  await picker.getByRole('button', { name: 'Use selected (1)' }).click();
  await expect(page.getByTestId('product-media').locator('img')).toHaveCount(1);

  await page.getByRole('button', { name: 'Create product' }).click();
  await expect(page).toHaveURL(/\/dashboard\/products\/(?!new$)\w+$/);
  await expect(page.getByRole('heading', { name: 'Grilled chicken' })).toBeVisible();
  // The image is served through a signed, same-origin API URL.
  const src = await page.getByTestId('product-media').locator('img').first().getAttribute('src');
  expect(src).toMatch(/^\/api\/v1\/media\/\w+\/content\?exp=\d+&sig=/);
  const img = await page.request.get(src!);
  expect(img.status()).toBe(200);
  expect(img.headers()['content-type']).toBe('image/png');

  await page.getByRole('link', { name: 'Products' }).first().click();
  const list = page.getByTestId('product-list');
  await expect(list).toContainText('Grilled chicken');
  await expect(list).toContainText('Main dishes');
  await expect(list.locator('img')).toHaveCount(1);

  await page.getByRole('link', { name: 'New product' }).first().click();
  await expect(page.getByRole('heading', { name: 'New product' })).toBeVisible();
  await page.getByLabel('Name', { exact: true }).fill('Bissap juice');
  await page.getByLabel('Category (optional)').selectOption({ label: 'Drinks' });
  await page.getByRole('button', { name: 'Create product' }).click();
  await expect(page.getByRole('heading', { name: 'Bissap juice' })).toBeVisible();

  await page.getByRole('link', { name: 'Products' }).first().click();
  await page.getByLabel('Search by name, SKU or description').fill('bissap');
  await expect(list.locator('li')).toHaveCount(1);
  await page.getByLabel('Search by name, SKU or description').fill('');
  await page.getByLabel('Category', { exact: true }).selectOption({ label: 'Main dishes' });
  await expect(list.locator('li')).toHaveCount(1);
  await expect(list).toContainText('Grilled chicken');
  await page.getByLabel('Category', { exact: true }).selectOption({ label: 'All categories' });

  await page.getByRole('link', { name: 'Edit Bissap juice' }).click();
  await expect(page.getByRole('heading', { name: 'Bissap juice' })).toBeVisible();
  await page.getByLabel('Stock quantity (optional)').fill('25');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('status')).toHaveText('Saved');
  await page.getByRole('link', { name: 'Products' }).first().click();
  await expect(list).toContainText('25 in stock');

  await page.getByRole('button', { name: 'Delete Bissap juice' }).click();
  const confirm = page.getByRole('dialog', { name: 'Delete product' });
  await expect(confirm).toContainText('Bissap juice');
  await confirm.getByRole('button', { name: 'Delete' }).click();
  await expect(list.locator('li')).toHaveCount(1);
});

test('services, categories and knowledge base', async ({ page }) => {
  await setup(page);
  await page.getByRole('link', { name: 'Categories' }).click();
  await page.getByRole('tab', { name: 'Services' }).click();
  await expect(page.getByTestId('category-list')).toContainText('Delivery');
  await page.getByRole('button', { name: 'New category' }).click();
  await page.getByRole('dialog').getByLabel('Name').fill('Cooking classes');
  await page.getByRole('dialog').getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByTestId('category-list')).toContainText('Cooking classes');

  await page.getByRole('link', { name: 'Services' }).click();
  await page.getByRole('link', { name: 'New service' }).first().click();
  await expect(page.getByRole('heading', { name: 'New service' })).toBeVisible();
  await page.getByLabel('Name', { exact: true }).fill('Chadian cooking class');
  await page.getByLabel('Category (optional)').selectOption({ label: 'Cooking classes' });
  await page.getByLabel('Price (optional)', { exact: true }).fill('15000');
  await page.getByLabel('Duration (minutes) (optional)').fill('120');
  await page.getByLabel('Availability', { exact: true }).selectOption('BY_APPOINTMENT');
  await page.getByLabel('Booking information (optional)').fill('WhatsApp +235 66 00 00 00');
  await page.getByRole('button', { name: 'Create service' }).click();
  await expect(page.getByRole('heading', { name: 'Chadian cooking class' })).toBeVisible();
  await page.getByRole('link', { name: 'Services' }).first().click();
  await expect(page.getByTestId('service-list')).toContainText('120 min');

  await page.getByRole('link', { name: 'Knowledge base' }).click();
  await expect(page.getByTestId('ai-context')).toContainText('No verified delivery policy information');
  await page.getByRole('button', { name: 'New entry' }).click();
  const dlg = page.getByRole('dialog', { name: 'New entry' });
  await dlg.getByLabel('Topic').selectOption('DELIVERY_POLICY');
  await dlg.getByLabel('Title').fill('Delivery area');
  await dlg.getByLabel('Content').fill("We deliver in N'Djamena from 11:00 to 21:00 for 1 000 XAF.");
  await dlg.getByRole('button', { name: 'Save changes' }).click();
  const entries = page.getByTestId('knowledge-list');
  await expect(entries).toContainText('Pending verification');
  await entries.getByRole('button', { name: 'Verify' }).click();
  await expect(entries).toContainText('Verified by Awa Mahamat');
  await expect(page.getByTestId('ai-context')).not.toContainText('No verified delivery policy information');
});

test('media library: upload, reject spoofed file, organise, delete; business logo', async ({ page }) => {
  await setup(page);
  await page.getByRole('link', { name: 'Media library' }).click();
  await expect(page.getByText('No media yet.')).toBeVisible();
  const input = page.getByTestId('media-file-input');
  await input.setInputFiles([image('dish.png', 120, 80)]);
  const grid = page.getByTestId('media-grid');
  await expect(grid).toContainText('dish.png');
  await expect(grid).toContainText('120×80');

  // A text file pretending to be a PNG passes the browser check but is rejected by the server.
  await input.setInputFiles([{ name: 'fake.png', mimeType: 'image/png', buffer: Buffer.from('not really an image') }]);
  await expect(page.getByText('Unsupported file type. Use JPEG, PNG, WebP, GIF, MP4, MOV or WebM.')).toBeVisible();
  await expect(grid.locator('li')).toHaveCount(1);

  await page.getByRole('button', { name: 'Open dish.png' }).click();
  const detail = page.getByRole('dialog', { name: 'dish.png' });
  await detail.getByLabel('Folder').fill('menu/2026');
  await detail.getByLabel('Alternative text').fill('Plate of grilled fish');
  await detail.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('navigation', { name: 'Folders' })).toContainText('menu/2026');

  // Logo from the business page.
  await page.getByRole('link', { name: 'Businesses' }).click();
  await page.getByRole('button', { name: 'Manage' }).click();
  await expect(page.getByTestId('business-logo').locator('img')).toHaveCount(0);
  await page.getByRole('button', { name: 'Upload a logo' }).click();
  const picker = page.getByRole('dialog', { name: 'Choose media' });
  await picker.getByRole('button', { name: 'Plate of grilled fish' }).click();
  await picker.getByRole('button', { name: 'Use selected (1)' }).click();
  await expect(page.getByTestId('business-logo').locator('img')).toHaveCount(1);

  // Deleting the media removes it from the logo too.
  await page.getByRole('link', { name: 'Media library' }).click();
  await page.getByRole('button', { name: 'Open dish.png' }).click();
  await expect(page.getByRole('dialog', { name: 'dish.png' })).toContainText('Used by: Logo');
  await page.getByRole('dialog', { name: 'dish.png' }).getByRole('button', { name: 'Delete' }).click();
  await page.getByRole('dialog', { name: 'Delete media' }).getByRole('button', { name: 'Delete' }).click();
  await expect(page.getByText('No media yet.')).toBeVisible();
  await page.getByRole('link', { name: 'Businesses' }).click();
  await page.getByRole('button', { name: 'Manage' }).click();
  await expect(page.getByTestId('business-logo').locator('img')).toHaveCount(0);
});

test('business management: contact details, second business isolation', async ({ page }) => {
  await setup(page, 'First Maquis');
  await page.getByRole('link', { name: 'Businesses' }).click();
  await page.getByRole('link', { name: 'New business' }).click();
  await page.getByLabel('Business name').fill('Second Boutique');
  await page.getByLabel('Business type').selectOption('ECOMMERCE');
  await page.getByLabel('City (optional)').fill('Abéché');
  await page.getByLabel('Contact email (optional)').fill('bad-email');
  await page.getByRole('button', { name: 'Create business' }).click();
  await expect(page.getByTestId('form-error')).toBeVisible();
  await page.getByLabel('Contact email (optional)').fill('contact@boutique.example');
  await page.getByLabel('Contact phone (optional)').fill('+235 66 11 22 33');
  await page.getByRole('button', { name: 'Create business' }).click();
  await expect(page).toHaveURL(/\/dashboard\/businesses\/\w+$/);
  await expect(page.getByLabel('City (optional)')).toHaveValue('Abéché');

  // Catalog is per business: the new e-commerce business has its own default categories and no products.
  await page.getByRole('link', { name: 'Categories' }).click();
  await expect(page.getByTestId('category-list')).toContainText('Clothing');
  await expect(page.getByTestId('category-list')).not.toContainText('Main dishes');
  await page.getByLabel('Active business').selectOption({ label: 'First Maquis' });
  await expect(page.getByTestId('category-list')).toContainText('Main dishes');
});
