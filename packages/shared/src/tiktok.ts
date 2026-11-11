import type { ContentKind } from './social';

/**
 * TikTok posting settings a person chooses for one post, following TikTok's Content Sharing Guidelines
 * (Content Posting API, Direct Post): nothing is pre-selected on the creator's behalf, privacy is chosen from the options the
 * creator's account allows, interaction controls default to OFF, commercial content is disclosed explicitly and the creator
 * confirms before posting. The rules below are the ones TOUMA can check without calling TikTok; the options the creator's
 * account actually offers are re-checked against TikTok at publication time.
 */
export const TIKTOK_PRIVACY_LEVELS = ['PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'FOLLOWER_OF_CREATOR', 'SELF_ONLY'] as const;
export type TikTokPrivacyLevel = (typeof TIKTOK_PRIVACY_LEVELS)[number];

export interface TikTokPostSettings {
  /** No default: the person must choose. */
  privacyLevel: TikTokPrivacyLevel;
  /** Allow others to comment / duet / stitch. Off unless the person turns them on. */
  allowComment: boolean;
  allowDuet: boolean;
  allowStitch: boolean;
  commercial: { enabled: boolean; yourBrand: boolean; brandedContent: boolean };
  /** The person agreed to TikTok's Music Usage Confirmation (and the Branded Content Policy when branded content is declared). */
  consent: boolean;
  /** Set by the server when the settings are saved. */
  confirmedAt?: string;
  confirmedById?: string;
}

export type TikTokLabel = 'NONE' | 'PROMOTIONAL' | 'PAID_PARTNERSHIP';

/** The label TikTok shows on the post for a disclosure. */
export function tiktokLabel(s: Pick<TikTokPostSettings, 'commercial'>): TikTokLabel {
  if (!s.commercial.enabled) return 'NONE';
  if (s.commercial.brandedContent) return 'PAID_PARTNERSHIP';
  return s.commercial.yourBrand ? 'PROMOTIONAL' : 'NONE';
}

export type TikTokSettingsCheck = { ok: true; value: TikTokPostSettings } | { ok: false; errors: Array<{ code: string; message: string }> };

/** Structural and policy checks. `kind` decides whether duet/stitch exist (video only). */
export function checkTikTokSettings(input: unknown, kind: ContentKind): TikTokSettingsCheck {
  const errors: Array<{ code: string; message: string }> = [];
  const s = (input && typeof input === 'object' ? input : {}) as Partial<TikTokPostSettings> & { commercial?: Partial<TikTokPostSettings['commercial']> };
  if (!s.privacyLevel || !(TIKTOK_PRIVACY_LEVELS as readonly string[]).includes(s.privacyLevel)) errors.push({ code: 'PRIVACY_REQUIRED', message: 'Choose who can view this post. TikTok requires the creator to pick the visibility; there is no default.' });
  for (const k of ['allowComment', 'allowDuet', 'allowStitch'] as const) if (s[k] !== undefined && typeof s[k] !== 'boolean') errors.push({ code: 'INVALID_FLAG', message: `${k} must be true or false.` });
  const c = { enabled: s.commercial?.enabled === true, yourBrand: s.commercial?.yourBrand === true, brandedContent: s.commercial?.brandedContent === true };
  if (c.enabled && !c.yourBrand && !c.brandedContent) errors.push({ code: 'DISCLOSURE_INCOMPLETE', message: 'Commercial content is switched on: select "Your brand", "Branded content" or both.' });
  if (!c.enabled && (c.yourBrand || c.brandedContent)) errors.push({ code: 'DISCLOSURE_INCONSISTENT', message: 'A commercial content type is selected but the commercial content disclosure is off.' });
  if (c.enabled && c.brandedContent && s.privacyLevel === 'SELF_ONLY') errors.push({ code: 'BRANDED_NOT_PRIVATE', message: 'Branded content visibility cannot be set to private.' });
  const isVideo = kind === 'VIDEO';
  if (!isVideo && (s.allowDuet === true || s.allowStitch === true)) errors.push({ code: 'VIDEO_ONLY_CONTROL', message: 'Duet and Stitch exist for videos only.' });
  if (s.consent !== true) errors.push({ code: 'CONSENT_REQUIRED', message: c.enabled && c.brandedContent ? "Confirm TikTok's Branded Content Policy and Music Usage Confirmation." : "Confirm TikTok's Music Usage Confirmation." });
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    value: {
      privacyLevel: s.privacyLevel!, allowComment: s.allowComment === true, allowDuet: isVideo && s.allowDuet === true, allowStitch: isVideo && s.allowStitch === true,
      commercial: c, consent: true, ...(s.confirmedAt ? { confirmedAt: s.confirmedAt } : {}), ...(s.confirmedById ? { confirmedById: s.confirmedById } : {}),
    },
  };
}

/** What TikTok reports about the creator's account when asked right before posting (creator_info/query). */
export interface TikTokCreatorInfo {
  nickname: string | null;
  username: string | null;
  avatarUrl: string | null;
  /** The visibility options this creator may choose from today. */
  privacyOptions: TikTokPrivacyLevel[];
  /** The creator turned these interactions off in their TikTok settings: they cannot be enabled for a post. */
  commentDisabled: boolean;
  duetDisabled: boolean;
  stitchDisabled: boolean;
  maxVideoPostDurationSec: number | null;
}
