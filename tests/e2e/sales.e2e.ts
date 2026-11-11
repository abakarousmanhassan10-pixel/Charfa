import { expect, test, type Page } from '@playwright/test';

/**
 * AI sales agent: dashboard (desktop and phone) and the customer chat. The API runs with the TEST-ONLY deterministic text model:
 * these tests prove TOUMA's behavior (verified data, handoff, human control, isolation of what customers see), not the quality of a real model.
 */
async function setup(page: Page) {
  await page.goto('/register');
  await page.getByLabel('Full name').fill('Awa Mahamat');
  await page.getByLabel('Email').fill(`sales${Date.now()}${Math.floor(Math.random() * 1e6)}@example.com`);
  await page.getByLabel('Password').fill('Correct-Horse-9-Battery');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByLabel('Business name').fill('Maquis Awa');
  await page.getByLabel('Business type').selectOption('RESTAURANT');
  await page.getByLabel('Currency').selectOption('XAF');
  await page.getByRole('button', { name: 'Create my business' }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await page.evaluate(async () => {
    const call = async (path: string, init?: { method: string; body?: unknown; businessId: string }) => {
      for (let i = 0; i < 8; i++) {
        const refreshed = await fetch('/api/v1/auth/refresh', { method: 'POST', headers: { 'x-touma-csrf': '1' } });
        if (refreshed.ok) {
          const { accessToken } = await refreshed.json();
          const res = await fetch(path, { method: init?.method ?? 'GET', headers: { authorization: `Bearer ${accessToken}`, ...(init ? { 'x-business-id': init.businessId, 'content-type': 'application/json' } : {}) }, body: init?.body ? JSON.stringify(init.body) : undefined });
          if (res.ok) return res.json();
        }
        await new Promise((r) => setTimeout(r, 250));
      }
      throw new Error(`could not call ${path}`);
    };
    const biz = (await call('/api/v1/businesses'))[0] as { id: string };
    await call('/api/v1/products', { method: 'POST', businessId: biz.id, body: { name: 'Bissap juice', price: '1500', status: 'ACTIVE', benefits: ['Refreshing'] } });
    await call('/api/v1/products', { method: 'POST', businessId: biz.id, body: { name: 'Ginger juice', price: '2000', status: 'ACTIVE', benefits: ['Energising'] } });
    const k = await call('/api/v1/business-knowledge', { method: 'POST', businessId: biz.id, body: { category: 'DELIVERY_POLICY', title: 'Delivery', body: 'We deliver within the city in 24 hours for a flat fee of 1 000 XAF.' } });
    await call(`/api/v1/business-knowledge/${k.id}/verify`, { method: 'POST', businessId: biz.id });
  });
}

/** Turns the agent on from the dashboard (the real settings form) and returns the customer chat link. */
async function enableAgent(page: Page, mode: 'AUTO' | 'REVIEW') {
  await page.goto('/dashboard/sales/agent');
  await page.getByTestId('agent-enabled').check();
  for (const l of ['tr', 'ar']) await page.getByTestId(`agent-lang-${l}`).check();
  await page.getByTestId(`agent-mode-${mode}`).check();
  await page.getByTestId('agent-save').click();
  if (mode === 'AUTO') {
    const dialog = page.getByTestId('auto-dialog');
    await expect(dialog).toContainText('cannot place orders');
    await dialog.getByTestId('auto-confirm').click();
  }
  await expect(page.getByTestId('agent-message')).toContainText('Settings saved');
  const link = (await page.getByTestId('agent-link').locator('code').textContent())!.trim();
  return new URL(link).pathname;
}

const say = async (chat: Page, text: string) => {
  const before = await chat.getByTestId('chat-message').count();
  await chat.getByTestId('chat-input').fill(text);
  await chat.getByTestId('chat-send').click();
  await expect(chat.getByTestId('chat-message')).not.toHaveCount(before);
};

test('the customer chat does not exist until the agent is turned on, and the setting needs an explicit authorization for automatic answers', async ({ page, context }) => {
  await setup(page);
  await page.goto('/dashboard/sales/agent');
  await expect(page.getByTestId('agent-enabled')).not.toBeChecked();
  await expect(page.getByTestId('agent-mode-REVIEW')).toBeChecked(); // review is the default
  await page.getByTestId('agent-enabled').check();
  await page.getByTestId('agent-save').click();
  await expect(page.getByTestId('agent-message')).toBeVisible();
  const path = new URL((await page.getByTestId('agent-link').locator('code').textContent())!.trim()).pathname;
  await page.getByTestId('agent-enabled').uncheck();
  await page.getByTestId('agent-save').click();
  await expect(page.getByTestId('agent-message')).toBeVisible();
  const chat = await context.newPage();
  await chat.goto(path);
  await expect(chat.getByTestId('chat-unavailable')).toBeVisible();
  // Switching to automatic answers asks for a recorded authorization.
  await page.getByTestId('agent-mode-AUTO').check();
  await page.getByTestId('agent-save').click();
  await expect(page.getByTestId('auto-dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('agent-authorized')).toHaveCount(0); // nothing authorized by cancelling
});

test('a customer chats: verified price and product card, languages, delivery policy, and an order question goes to a person', async ({ page, context }) => {
  await setup(page);
  const path = await enableAgent(page, 'AUTO');
  const chat = await context.newPage();
  await chat.goto(path);
  await expect(chat.getByTestId('chat-disclosure')).toContainText('AI assistant');
  await expect(chat.getByTestId('chat-greeting')).toContainText('virtual assistant');
  await say(chat, 'How much is the Bissap juice?');
  const reply = chat.locator('[data-role="assistant"]').last();
  await expect(reply).toContainText('1500');
  await expect(reply.getByTestId('chat-card')).toContainText('Bissap juice');
  await say(chat, 'Combien coûte le Ginger juice ?');
  await expect(chat.locator('[data-role="assistant"]').last()).toContainText('coûte');
  await say(chat, 'What is your delivery policy?');
  await expect(chat.locator('[data-role="assistant"]').last()).toContainText('flat fee of 1 000 XAF');
  await say(chat, 'Is the juice organic and halal certified?');
  await expect(chat.locator('[data-role="system"]').last()).toContainText('verified information'); // not guessed
  await expect(chat.getByTestId('chat-waiting')).toBeVisible();
  // The conversation survives a reload (the secret lives in this browser).
  await chat.reload();
  await expect(chat.getByTestId('chat-message')).toHaveCount(8);
});

test('order status is never answered by the AI: the team is told, and the customer gets an honest message', async ({ page, context }) => {
  await setup(page);
  const path = await enableAgent(page, 'AUTO');
  const chat = await context.newPage();
  await chat.goto(path);
  await say(chat, 'Where is my order? I need tracking');
  await expect(chat.locator('[data-role="system"]').last()).toContainText('cannot see order or delivery details');
  await page.goto('/dashboard/sales');
  const item = page.getByTestId('conversation-item').first();
  await expect(item).toHaveAttribute('data-status', 'PENDING_HUMAN');
  await expect(item).toContainText('Needs a person');
  await item.click();
  await expect(page.getByTestId('handoff-banner')).toContainText('order or delivery status');
  await expect(page.getByTestId('resume')).toBeVisible(); // AI is paused
});

test('human control: take over, reply to the customer, correct the AI, add a private note, resume', async ({ page, context }) => {
  await setup(page);
  const path = await enableAgent(page, 'AUTO');
  const chat = await context.newPage();
  await chat.goto(path);
  await chat.getByTestId('chat-contact').locator('summary').click();
  await chat.getByTestId('chat-name').fill('Moussa');
  await chat.getByTestId('chat-phone').fill('+235 66 33 44 55');
  await chat.getByTestId('chat-consent').check();
  await say(chat, 'I want to buy the Ginger juice');
  await expect(chat.locator('[data-role="assistant"]').last()).toContainText('leave your name and phone');
  await page.goto('/dashboard/sales');
  await page.getByTestId('conversation-item').first().click();
  const detail = page.getByTestId('conversation-detail');
  await expect(detail.getByTestId('ai-details')).toContainText('Confidence: high');
  await expect(detail.getByTestId('product-card').first()).toContainText('Ginger juice');
  // Report an inaccurate AI reply and prepare an UNVERIFIED knowledge entry.
  await detail.getByTestId('report-inaccurate').click();
  await page.getByTestId('report-note').fill('Delivery fee changed');
  await page.getByTestId('report-correction').fill('Delivery now costs 2 000 XAF.');
  await page.getByTestId('report-knowledge').check();
  await page.getByTestId('report-send').click();
  await expect(detail.getByTestId('flagged')).toBeVisible();
  // Take over and reply: the customer sees the person's message and the AI stays quiet.
  await detail.getByTestId('takeover').click();
  await expect(page.getByTestId('conversation-detail').getByText('Team', { exact: true }).first()).toBeVisible();
  await detail.getByTestId('reply-input').fill('Hello Moussa, this is Awa. I will confirm your order by phone.');
  await detail.getByTestId('send-reply').click();
  await expect(chat.locator('[data-role="team"]').last()).toContainText('I will confirm your order by phone', { timeout: 15_000 });
  await say(chat, 'Thank you!');
  await expect(chat.locator('[data-role="assistant"]')).toHaveCount(1); // no new AI answer while a person is in charge
  // Internal note: visible to the team only.
  await detail.getByTestId('customer-panel').locator('summary').click();
  await detail.getByTestId('note-input').fill('Prefers phone calls after 5pm');
  await detail.getByTestId('note-add').click();
  await expect(detail.getByTestId('note')).toContainText('Prefers phone calls');
  await chat.reload();
  await expect(chat.locator('body')).not.toContainText('Prefers phone calls');
  await detail.getByTestId('resume').click();
  await say(chat, 'How much is the Bissap juice?');
  await expect(chat.locator('[data-role="assistant"]').last()).toContainText('1500', { timeout: 15_000 });
});

test('review mode: the AI only drafts, the customer sees nothing until the reply is approved (optionally edited)', async ({ page, context }) => {
  await setup(page);
  const path = await enableAgent(page, 'REVIEW');
  const chat = await context.newPage();
  await chat.goto(path);
  await say(chat, 'How much is the Bissap juice?');
  await expect(chat.locator('[data-role="system"]').last()).toContainText('team will reply shortly');
  await expect(chat.locator('[data-role="assistant"]')).toHaveCount(0);
  await page.goto('/dashboard/sales');
  const item = page.getByTestId('conversation-item').first();
  await expect(item.getByTestId('draft-pending')).toBeVisible();
  await item.click();
  const draft = page.locator('[data-testid="message"][data-approval="PENDING"]');
  await expect(draft).toContainText('AI draft – not sent');
  await draft.getByTestId('edit-draft').click();
  await draft.getByTestId('draft-edit').fill('Bissap juice costs 1500 XAF. Fresh today!');
  await draft.getByTestId('approve-edited').click();
  await expect(chat.locator('[data-role="assistant"]').last()).toContainText('Fresh today!', { timeout: 15_000 });
});

test('customers, leads, opportunities, FAQ gaps and analytics reflect the real conversations', async ({ page, context }) => {
  await setup(page);
  const path = await enableAgent(page, 'AUTO');
  const chat = await context.newPage();
  await chat.goto(path);
  await chat.getByTestId('chat-contact').locator('summary').click();
  await chat.getByTestId('chat-name').fill('Moussa');
  await chat.getByTestId('chat-phone').fill('+235 66 33 44 55');
  await chat.getByTestId('chat-consent').check();
  await say(chat, 'I want to buy the Ginger juice');
  await say(chat, 'Do you have gluten free cakes?');
  await page.goto('/dashboard/sales/customers');
  await expect(page.getByTestId('customer-item')).toHaveCount(1);
  await expect(page.getByTestId('customer-item')).toContainText('Moussa');
  await expect(page.getByTestId('customer-item')).toHaveAttribute('data-lead', 'OPPORTUNITY');
  await page.getByTestId('customer-item').click();
  const dialog = page.getByTestId('customer-dialog');
  await expect(dialog).toContainText('+235 66 33 44 55');
  await dialog.getByTestId('customer-note-input').fill('Wants delivery on Friday');
  await dialog.getByTestId('customer-note-add').click();
  await expect(dialog.getByTestId('customer-note')).toContainText('Friday');
  await page.keyboard.press('Escape');
  await page.goto('/dashboard/sales/leads');
  await expect(page.locator('[data-testid="lead-column"][data-stage="OPPORTUNITY"]').getByTestId('lead-card')).toContainText('Moussa');
  await page.goto('/dashboard/sales/opportunities');
  await expect(page.getByTestId('opportunity')).toContainText('Moussa');
  await expect(page.getByTestId('opportunity-product')).toContainText('Ginger juice');
  await expect(page.getByTestId('followup').first()).toBeVisible(); // the conversation waits for a person
  await page.goto('/dashboard/sales/faq');
  await expect(page.getByTestId('unanswered')).toContainText('gluten free cakes');
  await page.getByTestId('answer-question').click();
  await page.getByTestId('faq-answer').fill('Yes, we bake gluten free cakes on order.');
  await page.getByTestId('faq-save').click();
  await expect(page.getByTestId('faq-message')).toContainText('Verify it in the knowledge base');
  await expect(page.getByTestId('unverified-faq')).toContainText('1 answer');
  await page.goto('/dashboard/sales/analytics');
  await expect(page.locator('[data-stat="conversations"]')).toContainText('1');
  await expect(page.locator('[data-stat="handoffs"]')).toContainText('1');
  await expect(page.getByTestId('analytics-note')).toContainText('no order data');
});

test('the test chat in the agent settings works before the agent is on', async ({ page }) => {
  await setup(page);
  await page.goto('/dashboard/sales/agent');
  await page.getByTestId('playground-input').fill('How much is the Ginger juice?');
  await page.getByTestId('playground-send').click();
  await expect(page.getByTestId('playground-message').last()).toContainText('2000');
  await expect(page.getByTestId('playground-details')).toContainText('Confidence');
  await page.goto('/dashboard/sales');
  await expect(page.getByTestId('conversation-item')).toHaveCount(0); // test conversations are not listed or counted
});

test('the dashboard and the customer chat are available in French', async ({ page, context }) => {
  await setup(page);
  await page.context().addCookies([{ name: 'touma_locale', value: 'fr', url: 'http://localhost:3100' }]);
  await page.goto('/dashboard/sales/agent');
  await expect(page.getByRole('heading', { name: 'Réglages de l’agent' })).toBeVisible();
  await expect(page.getByTestId('sales-tabs')).toContainText('Conversations');
  await expect(page.getByTestId('agent-config')).toContainText('Relire chaque réponse');
  await page.getByTestId('agent-enabled').check();
  await page.getByTestId('agent-save').click();
  const path = new URL((await page.getByTestId('agent-link').locator('code').textContent())!.trim()).pathname;
  const chat = await context.newPage();
  await chat.goto(path);
  await expect(chat.getByTestId('chat-input')).toHaveAttribute('placeholder', 'Écrivez votre message');
});

test.describe('phone (390×844)', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('every sales page fits the screen without horizontal scrolling', async ({ page }) => {
    await setup(page);
    for (const p of ['', '/customers', '/leads', '/opportunities', '/faq', '/analytics', '/agent']) {
      await page.goto(`/dashboard/sales${p}`);
      await expect(page.getByTestId('sales-tabs')).toBeVisible();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, `/dashboard/sales${p}`).toBeLessThanOrEqual(1);
    }
  });

  test('conversations show one pane at a time with a way back, and the customer chat is usable', async ({ page, context }) => {
    await setup(page);
    const path = await enableAgent(page, 'AUTO');
    const chat = await context.newPage();
    await chat.setViewportSize({ width: 390, height: 844 });
    await chat.goto(path);
    await say(chat, 'How much is the Bissap juice?');
    await expect(chat.locator('[data-role="assistant"]').last()).toContainText('1500');
    expect(await chat.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
    await page.goto('/dashboard/sales');
    await expect(page.getByTestId('conversation-detail-pane')).toBeHidden(); // list only
    await page.getByTestId('conversation-item').first().click();
    await expect(page.getByTestId('conversation-detail')).toBeVisible();
    await expect(page.getByTestId('conversation-list-pane')).toBeHidden(); // detail only
    await expect(page.getByTestId('takeover')).toBeVisible();
    await page.getByTestId('back-to-list').click();
    await expect(page.getByTestId('conversation-list-pane')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
  });
});
