import type { SocialPlatformId } from './social';

/**
 * Metrics TOUMA can analyze and what each platform's official API gives it (N22). Statements are about the platforms, not about this deployment.
 *  - IMPLEMENTED: a TOUMA adapter requests it (and a value the platform omits stays null, never 0).
 *  - DOCUMENTED_NOT_IMPLEMENTED: the platform documents it but TOUMA does not request it yet (usually another API or an extra scope).
 *  - UNVERIFIED: not confirmed in an official source read by TOUMA; treated as unavailable.
 * Nothing was tested against a real account.
 */
export const METRIC_NAMES = ['views', 'reach', 'impressions', 'likes', 'comments', 'shares', 'saves', 'avgWatchSeconds', 'linkClicks', 'conversions'] as const;
export type MetricName = (typeof METRIC_NAMES)[number];
export type MetricStatus = 'IMPLEMENTED' | 'DOCUMENTED_NOT_IMPLEMENTED' | 'UNVERIFIED' | 'UNSUPPORTED';

export const ANALYTICS_PLATFORMS = ['INSTAGRAM', 'TIKTOK', 'YOUTUBE'] as const satisfies readonly SocialPlatformId[];
export type AnalyticsPlatform = (typeof ANALYTICS_PLATFORMS)[number];

export interface PlatformAnalytics {
  api: string;
  /** Permissions needed to read post metrics (as the platform names them). */
  scopes: readonly string[];
  metrics: Record<MetricName, MetricStatus>;
  limits: string;
}

export const PLATFORM_ANALYTICS: Record<AnalyticsPlatform, PlatformAnalytics> = {
  INSTAGRAM: {
    api: 'Instagram Graph API (insights of a media object)',
    scopes: ['instagram_basic', 'instagram_manage_insights', 'pages_read_engagement'],
    metrics: { views: 'UNVERIFIED', reach: 'IMPLEMENTED', impressions: 'IMPLEMENTED', likes: 'IMPLEMENTED', comments: 'IMPLEMENTED', shares: 'IMPLEMENTED', saves: 'IMPLEMENTED', avgWatchSeconds: 'DOCUMENTED_NOT_IMPLEMENTED', linkClicks: 'UNSUPPORTED', conversions: 'UNSUPPORTED' },
    limits: 'Insights need a Business/Creator account and Meta app review; available metrics vary by media type and API version, and some appear with a delay. Rate limits are set by Meta and were not verified here.',
  },
  TIKTOK: {
    api: 'TikTok API v2 (video query: view, like, comment, share counts)',
    scopes: ['video.list'],
    metrics: { views: 'IMPLEMENTED', reach: 'UNVERIFIED', impressions: 'UNVERIFIED', likes: 'IMPLEMENTED', comments: 'IMPLEMENTED', shares: 'IMPLEMENTED', saves: 'UNVERIFIED', avgWatchSeconds: 'UNVERIFIED', linkClicks: 'UNSUPPORTED', conversions: 'UNSUPPORTED' },
    limits: 'Private posts have no public statistics; unaudited apps post privately only. Reach, impressions, saves and watch time were not found in the fields TOUMA requests.',
  },
  YOUTUBE: {
    api: 'YouTube Data API v3 (videos.list statistics); YouTube Analytics API for watch time',
    scopes: ['https://www.googleapis.com/auth/youtube.readonly', 'https://www.googleapis.com/auth/yt-analytics.readonly'],
    metrics: { views: 'IMPLEMENTED', reach: 'DOCUMENTED_NOT_IMPLEMENTED', impressions: 'DOCUMENTED_NOT_IMPLEMENTED', likes: 'IMPLEMENTED', comments: 'IMPLEMENTED', shares: 'DOCUMENTED_NOT_IMPLEMENTED', saves: 'UNSUPPORTED', avgWatchSeconds: 'DOCUMENTED_NOT_IMPLEMENTED', linkClicks: 'UNSUPPORTED', conversions: 'UNSUPPORTED' },
    limits: 'Default quota 10,000 units per day per project (shared with uploads); a hidden like count is absent, not zero. Watch time needs the Analytics API and its scope, which TOUMA does not use yet.',
  },
};

/** Which metrics a platform's adapter can fill today. */
export const availableMetrics = (platform: string): MetricName[] => {
  const p = (PLATFORM_ANALYTICS as Record<string, PlatformAnalytics>)[platform];
  return p ? METRIC_NAMES.filter((m) => p.metrics[m] === 'IMPLEMENTED') : [];
};

export type Freshness = 'FRESH' | 'RECENT' | 'STALE';
/** How old a measurement is. Lifetime numbers keep moving for days, so even a day-old reading is "recent", not "fresh". */
export function freshnessOf(fetchedAt: Date, now: Date): Freshness {
  const h = (now.getTime() - fetchedAt.getTime()) / 3_600_000;
  return h <= 24 ? 'FRESH' : h <= 24 * 7 ? 'RECENT' : 'STALE';
}

/** A post is measured only after the maturity window; before it, early numbers would be read as final. */
export const isMature = (publishedAt: Date, now: Date, maturityHours: number) => now.getTime() - publishedAt.getTime() >= maturityHours * 3_600_000;

/** Engagement rate from the parts the platform provided. null unless both an audience (reach, else impressions, else views) and at least one interaction exist. */
export function engagementRate(m: { reach: number | null; impressions: number | null; views: number | null; likes: number | null; comments: number | null; shares: number | null; saves: number | null }): number | null {
  const audience = m.reach ?? m.impressions ?? m.views;
  const parts = [m.likes, m.comments, m.shares, m.saves].filter((v): v is number => v !== null);
  if (audience === null || audience <= 0 || parts.length === 0) return null;
  return Math.round((parts.reduce((a, b) => a + b, 0) / audience) * 10_000) / 10_000;
}
