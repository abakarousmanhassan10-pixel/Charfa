import { randomBytes } from 'crypto';
import type { PrismaService } from '../prisma/prisma.service';

const POOL = ['#bissap', '#jus', '#promo', '#nouveaute', '#coulisses'];
const SHORT = 'Fresh bissap juice, made today.';
const MEDIUM = 'Our hibiscus bissap is brewed every morning with fresh flowers and served ice cold. Come and taste it today.';
const LONG = `${MEDIUM} We pick the flowers ourselves, steep them overnight, and sweeten the drink only a little so the natural flavor stays. Ask the team about our family sizes and our weekly tasting evenings, where you can try every flavor before you choose.`;
const HOURS = [7, 12, 18, 19, 20, 9, 13, 18, 8, 19];

/**
 * FICTITIOUS history for the demo and the tests: published posts with varied times, formats, caption lengths and hooks. The posts are flagged `simulated`, the
 * metrics are produced by the simulator, and nothing is sent anywhere. Returns the publication ids.
 */
export async function seedHistory(prisma: PrismaService, o: { businessId: string; socialAccountId: string; platform: 'INSTAGRAM' | 'TIKTOK' | 'YOUTUBE'; count?: number; now?: Date }): Promise<string[]> {
  const now = o.now ?? new Date();
  const count = o.count ?? 30;
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const at = new Date(now.getTime() - (4 + (count - 1 - i) * 1.8) * 86_400_000);
    at.setUTCHours(HOURS[i % HOURS.length]!, 0, 0, 0);
    const kind = o.platform === 'INSTAGRAM' ? (i % 4 === 0 ? 'VIDEO' : 'IMAGE') : 'VIDEO';
    const caption = [SHORT, MEDIUM, LONG][i % 3]!;
    const question = i % 3 === 0;
    const content = await prisma.content.create({ data: { businessId: o.businessId, type: kind as never, title: question ? `Have you tried our bissap #${i + 1}?` : `Fresh bissap #${i + 1}`, caption, hashtags: [POOL[i % POOL.length]!, '#bissap'], status: 'PUBLISHED', origin: 'HUMAN', targetPlatforms: [o.platform], createdAt: at } });
    const pub = await prisma.publication.create({ data: { businessId: o.businessId, contentId: content.id, socialAccountId: o.socialAccountId, platform: o.platform, status: 'PUBLISHED', scheduledAt: at, publishedAt: at, timezone: 'UTC', idempotencyKey: `demo-${randomBytes(8).toString('hex')}`, simulated: true, confirmedByProvider: true, externalPostId: `sim-${randomBytes(4).toString('hex')}`, createdAt: at } });
    ids.push(pub.id);
  }
  return ids;
}
