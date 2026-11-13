import type { SocialPlatformId } from './social';

/**
 * What each platform's OFFICIAL API lets TOUMA do, beyond publishing (Phase N19). This is a statement about the platforms, not
 * about this deployment: nothing here proves a real app registration, a granted permission or an approved review.
 * Status of each statement:
 *  - DOCUMENTED: the platform's official documentation describes it; not yet exercised against the real platform by TOUMA.
 *  - UNVERIFIED: sources disagree or the official page could not be read; treat as unknown until checked.
 *  - UNSUPPORTED: the platform offers no such API to TOUMA (or none was found).
 *  - NOT_IMPLEMENTED: the platform offers it, TOUMA does not implement it.
 */
export type FeatureStatus = 'DOCUMENTED' | 'UNVERIFIED' | 'UNSUPPORTED' | 'NOT_IMPLEMENTED';
export type FeatureKey = 'commentsRead' | 'commentsReply' | 'directMessages';
export const FEATURE_KEYS: readonly FeatureKey[] = ['commentsRead', 'commentsReply', 'directMessages'];

export interface FeatureSpec {
  status: FeatureStatus;
  /** Permissions that must ALL be granted (names as the platform reports them). Empty when unsupported. */
  scopes: readonly string[];
  note: string;
}

export interface PlatformFeatures {
  commentsRead: FeatureSpec;
  commentsReply: FeatureSpec;
  directMessages: FeatureSpec;
  accountTypes: string;
  appReview: string;
  quota: string;
  sandbox: string;
}

const YT = 'https://www.googleapis.com/auth/youtube';
const none = (note: string): FeatureSpec => ({ status: 'UNSUPPORTED', scopes: [], note });

export const PLATFORM_FEATURES: Record<SocialPlatformId, PlatformFeatures> = {
  INSTAGRAM: {
    commentsRead: { status: 'DOCUMENTED', scopes: ['instagram_manage_comments', 'pages_read_engagement'], note: 'Comment moderation API (Instagram API with Facebook Login).' },
    commentsReply: { status: 'DOCUMENTED', scopes: ['instagram_manage_comments', 'pages_read_engagement'], note: 'POST /{comment-id}/replies.' },
    directMessages: { status: 'NOT_IMPLEMENTED', scopes: ['instagram_manage_messages'], note: 'The Instagram messaging API exists (24-hour reply window, app review) but TOUMA does not implement it.' },
    accountTypes: 'Business or Creator account linked to a Facebook Page.',
    appReview: 'Advanced Access needs App Review and Business Verification when serving accounts you do not own; Standard Access is enough for accounts you own or manage.',
    quota: 'Graph API application and business-use-case rate limits (not verified for this application).',
    sandbox: 'In development mode only people with a role on the app can connect.',
  },
  FACEBOOK: {
    commentsRead: { status: 'UNVERIFIED', scopes: ['pages_read_engagement'], note: 'GET /{object-id}/comments. Official pages disagree on whether pages_read_user_content or pages_manage_engagement is also needed.' },
    commentsReply: { status: 'UNVERIFIED', scopes: ['pages_manage_engagement'], note: 'POST /{object-id}/comments with a Page token of a person allowed to moderate.' },
    directMessages: { status: 'NOT_IMPLEMENTED', scopes: ['pages_messaging'], note: 'The Messenger Platform exists (24-hour standard messaging window, app review) but TOUMA does not implement it.' },
    accountTypes: 'Facebook Page (the person needs a role on it).',
    appReview: 'Advanced Access and business verification to serve Pages you do not own; comment permissions are reviewed.',
    quota: 'Graph API rate limits (not verified for this application).',
    sandbox: 'In development mode only people with a role on the app can connect.',
  },
  TIKTOK: {
    commentsRead: none('TikTok comments are not offered through the Content Posting API TOUMA uses. Business-account comment APIs were not verified.'),
    commentsReply: none('No official comment-reply API was verified for TOUMA.'),
    directMessages: none('TikTok direct messages were not verified as available (reported as limited by region).'),
    accountTypes: 'TikTok account authorizing the app (publishing only).',
    appReview: 'The application must be audited by TikTok before public posting; unaudited apps can only post privately.',
    quota: 'Per-creator posting limits reported by creator_info.',
    sandbox: 'Unaudited clients can only post to private accounts.',
  },
  YOUTUBE: {
    commentsRead: { status: 'UNVERIFIED', scopes: [`${YT}.readonly`], note: 'commentThreads.list (1 quota unit). The read scope could not be confirmed on Google\'s reference page.' },
    commentsReply: { status: 'UNVERIFIED', scopes: [`${YT}.force-ssl`], note: 'comments.insert costs 50 quota units; third-party sources say the youtube.force-ssl scope is required for writes.' },
    directMessages: none('YouTube has no direct-message API.'),
    accountTypes: 'Google account with a YouTube channel (the channel must be merged with the Google account to comment).',
    appReview: 'Sensitive scopes need OAuth consent-screen verification; uploads by unaudited API projects are locked to private.',
    quota: 'Default 10,000 quota units per day per project, shared by every call (about 200 replies per day if nothing else is used).',
    sandbox: 'Unverified projects show warnings and limit users; unaudited uploads stay private.',
  },
  LINKEDIN: {
    commentsRead: none('Reading comments needs LinkedIn\'s Community Management API, which is not approved for TOUMA.'),
    commentsReply: none('Same: not approved for TOUMA.'),
    directMessages: none('No direct-message API is available to TOUMA.'),
    accountTypes: 'Personal profile (organization pages need an approved Community Management application).',
    appReview: 'Organization publishing and comment management need LinkedIn approval.',
    quota: 'Not verified.',
    sandbox: 'Not verified.',
  },
};

export type FeatureState = 'AVAILABLE' | 'PERMISSION_MISSING' | 'UNVERIFIED' | 'UNSUPPORTED' | 'NOT_IMPLEMENTED';
export interface FeatureResult {
  state: FeatureState;
  /** Permissions still to be granted (PERMISSION_MISSING). */
  missingScopes: string[];
  note: string;
}

/**
 * The state of each optional feature for an account, from the permissions it was actually granted.
 * AVAILABLE means technically possible with the permissions held (and still subject to the platform's own review and quotas);
 * UNVERIFIED means possible on paper only. `implemented` lists what TOUMA's adapter for the platform implements.
 */
export function featureStates(platform: SocialPlatformId, granted: readonly string[], implemented: readonly FeatureKey[]): Record<FeatureKey, FeatureResult> {
  const spec = PLATFORM_FEATURES[platform];
  const out = {} as Record<FeatureKey, FeatureResult>;
  for (const k of FEATURE_KEYS) {
    const s = spec[k];
    if (s.status === 'UNSUPPORTED' || s.status === 'NOT_IMPLEMENTED') out[k] = { state: s.status, missingScopes: [], note: s.note };
    else if (!implemented.includes(k)) out[k] = { state: 'NOT_IMPLEMENTED', missingScopes: [], note: s.note };
    else {
      const missing = s.scopes.filter((x) => !granted.includes(x));
      out[k] = missing.length ? { state: 'PERMISSION_MISSING', missingScopes: [...missing], note: s.note } : { state: s.status === 'UNVERIFIED' ? 'UNVERIFIED' : 'AVAILABLE', missingScopes: [], note: s.note };
    }
  }
  return out;
}
