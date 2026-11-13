import { createHash } from 'crypto';

/**
 * Exactly what a person approves and authorizes (Phase N18). The hash covers every field that changes what is published,
 * where and when. It is stored at authorization and recomputed before every dispatch: any difference stops the publication.
 */
export interface SnapshotInput {
  contentId: string;
  version: number;
  type: string;
  title: string | null;
  caption: string | null;
  hashtags: string[];
  callToAction: string | null;
  platformOptions: unknown;
  mediaIds: string[];
  platform: string | null;
  socialAccountId: string | null;
  scheduledAt: Date;
  timezone: string;
}

/** Stable JSON: keys sorted, so the hash does not depend on property order. */
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(v ?? null);
}

/** TikTok settings carry the confirmation time and person; they do not change what is posted, so they stay out of the hash. */
function options(o: unknown) {
  const t = (o as { tiktok?: Record<string, unknown> } | null)?.tiktok;
  if (!t) return {};
  const { confirmedAt: _a, confirmedById: _b, ...rest } = t;
  return { tiktok: rest };
}

export function snapshotHash(i: SnapshotInput): string {
  return createHash('sha256')
    .update(stable({ contentId: i.contentId, version: i.version, type: i.type, title: i.title, caption: i.caption, hashtags: i.hashtags, callToAction: i.callToAction, options: options(i.platformOptions), media: i.mediaIds, platform: i.platform, account: i.socialAccountId, at: i.scheduledAt.toISOString(), tz: i.timezone }))
    .digest('hex');
}
