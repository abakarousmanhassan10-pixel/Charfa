/**
 * Idempotent seed: subscription plans only. No demo users, businesses or fake analytics.
 * Prices are configurable through env (PLAN_STARTER_PRICE etc.) and later via the admin UI.
 */
import { PrismaClient, Prisma, type PlanCode } from '@prisma/client';

const prisma = new PrismaClient();

const plans: Array<{
  code: PlanCode;
  name: string;
  description: string;
  defaultPrice: string;
  sortOrder: number;
  limits: Prisma.InputJsonObject;
}> = [
  {
    code: 'STARTER',
    name: 'Starter',
    description: 'For solo founders and small shops getting started.',
    defaultPrice: '19.00',
    sortOrder: 1,
    limits: { businesses: 1, seats: 2, socialAccounts: 3, aiCreditsPerMonth: 200, scheduledPostsPerMonth: 60, storageMb: 2048, agents: ['BUSINESS_ANALYST', 'PRODUCT_ANALYST', 'CONTENT_CREATOR', 'CUSTOMER_SUPPORT', 'SCHEDULER'], features: ['ai', 'calendar', 'sales'], salesInteractionsPerMonth: 100 },
  },
  {
    code: 'PRO',
    name: 'Pro',
    description: 'For growing businesses publishing across several platforms.',
    defaultPrice: '49.00',
    sortOrder: 2,
    limits: { businesses: 3, seats: 5, socialAccounts: 10, aiCreditsPerMonth: 1000, scheduledPostsPerMonth: 300, storageMb: 10240, agents: ['BUSINESS_ANALYST', 'PRODUCT_ANALYST', 'MARKETING_STRATEGIST', 'CONTENT_CREATOR', 'VISUAL_CREATOR', 'SCHEDULER', 'CUSTOMER_SUPPORT', 'PERFORMANCE_ANALYST'], features: ['ai', 'calendar', 'sales', 'creative', 'market', 'campaigns', 'workflows'], salesInteractionsPerMonth: 500 },
  },
  {
    code: 'BUSINESS',
    name: 'Business',
    description: 'For agencies and multi-brand teams.',
    defaultPrice: '99.00',
    sortOrder: 3,
    limits: { businesses: 10, seats: 20, socialAccounts: 40, aiCreditsPerMonth: 4000, scheduledPostsPerMonth: 1500, storageMb: 51200, agents: ['BUSINESS_ANALYST', 'PRODUCT_ANALYST', 'MARKETING_STRATEGIST', 'CONTENT_CREATOR', 'VISUAL_CREATOR', 'VIDEO_CREATOR', 'SCHEDULER', 'CUSTOMER_SUPPORT', 'PERFORMANCE_ANALYST'], features: ['ai', 'calendar', 'sales', 'creative', 'market', 'campaigns', 'workflows', 'intelligence', 'autopilot'], salesInteractionsPerMonth: 2000 },
  },
];

async function main() {
  for (const p of plans) {
    const price = process.env[`PLAN_${p.code}_PRICE`] ?? p.defaultPrice;
    const providerPriceId = process.env[`PLAN_${p.code}_PROVIDER_PRICE_ID`] || null;
    // Integer minor units, parsed from the decimal string (no floating point). Yearly defaults to 10 monthly prices (two months free).
    const [whole = '0', frac = ''] = price.split('.');
    const priceMinor = Number(whole + frac.padEnd(2, '0').slice(0, 2));
    const yearlyEnv = process.env[`PLAN_${p.code}_YEARLY_PRICE`];
    const yearlyMinor = yearlyEnv ? Number(yearlyEnv.split('.')[0] + (yearlyEnv.split('.')[1] ?? '').padEnd(2, '0').slice(0, 2)) : priceMinor * 10;
    await prisma.plan.upsert({
      where: { code: p.code },
      create: {
        code: p.code,
        name: p.name,
        description: p.description,
        priceAmount: new Prisma.Decimal(price),
        priceAmountMinor: priceMinor,
        yearlyPriceAmountMinor: yearlyMinor,
        currency: 'USD',
        limits: p.limits,
        sortOrder: p.sortOrder,
        providerPriceId,
      },
      // Do not overwrite admin-edited prices on re-seed; only fill the provider id if newly configured.
      update: providerPriceId ? { providerPriceId } : {},
    });
  }
  console.log(`Seeded ${plans.length} plans.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
