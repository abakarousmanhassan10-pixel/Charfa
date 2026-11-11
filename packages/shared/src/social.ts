/**
 * Social platforms, publishing formats and the limits TOUMA enforces before calling a platform.
 *
 * The limits are conservative values taken from each platform's public developer documentation at the time of writing.
 * Platforms change them: re-verify against the current documentation before launch (see docs/SOCIAL-INTEGRATIONS.md).
 */
export const SOCIAL_PLATFORMS = ['INSTAGRAM', 'FACEBOOK', 'TIKTOK', 'YOUTUBE', 'LINKEDIN'] as const;
export type SocialPlatformId = (typeof SOCIAL_PLATFORMS)[number];

export const CONTENT_KINDS = ['TEXT', 'IMAGE', 'CAROUSEL', 'VIDEO'] as const;
export type ContentKind = (typeof CONTENT_KINDS)[number];

/** How a video is published where the platform has a dedicated short-video surface. */
export const VIDEO_SURFACES = ['FEED', 'REEL', 'SHORT'] as const;
export type VideoSurface = (typeof VIDEO_SURFACES)[number];

export const ACCOUNT_STATUSES = ['CONNECTED', 'TOKEN_EXPIRED', 'PERMISSION_MISSING', 'DISCONNECTED', 'ERROR'] as const;

export const PUBLICATION_STATUSES = ['PENDING', 'QUEUED', 'PUBLISHING', 'AWAITING_PROVIDER', 'PUBLISHED', 'FAILED', 'CANCELLED', 'MANUAL_REQUIRED'] as const;
export type PublicationStatusId = (typeof PUBLICATION_STATUSES)[number];

export interface PlatformLimits {
  label: string;
  captionMax: number;
  hashtagsMax: number;
  /** The kinds the official API can publish for an account of this platform. Everything else needs manual publishing. */
  supports: Record<ContentKind, boolean>;
  /** Media is required (text only is not possible). */
  mediaRequired: boolean;
  imageMimes: readonly string[];
  imageMaxBytes: number;
  videoMimes: readonly string[];
  videoMaxBytes: number;
  videoMinSeconds: number;
  videoMaxSeconds: number;
  /** Maximum duration of a video published as a Reel / Short, where that surface exists. */
  shortVideoMaxSeconds?: number;
  carouselMin: number;
  carouselMax: number;
  /** The platform fetches media from a public URL (our signed media URL must be reachable from the internet). */
  mediaByUrl: boolean;
}

const MB = 1024 * 1024;
export const PLATFORM_CAPABILITIES: Record<SocialPlatformId, PlatformLimits> = {
  INSTAGRAM: {
    label: 'Instagram', captionMax: 2200, hashtagsMax: 30, supports: { TEXT: false, IMAGE: true, CAROUSEL: true, VIDEO: true }, mediaRequired: true,
    imageMimes: ['image/jpeg'], imageMaxBytes: 8 * MB, videoMimes: ['video/mp4', 'video/quicktime'], videoMaxBytes: 300 * MB, videoMinSeconds: 3, videoMaxSeconds: 900, shortVideoMaxSeconds: 900, carouselMin: 2, carouselMax: 10, mediaByUrl: true,
  },
  FACEBOOK: {
    label: 'Facebook', captionMax: 63206, hashtagsMax: 30, supports: { TEXT: true, IMAGE: true, CAROUSEL: true, VIDEO: true }, mediaRequired: false,
    imageMimes: ['image/jpeg', 'image/png'], imageMaxBytes: 10 * MB, videoMimes: ['video/mp4', 'video/quicktime'], videoMaxBytes: 1024 * MB, videoMinSeconds: 1, videoMaxSeconds: 14_400, carouselMin: 2, carouselMax: 10, mediaByUrl: true,
  },
  TIKTOK: {
    label: 'TikTok', captionMax: 2200, hashtagsMax: 30, supports: { TEXT: false, IMAGE: true, CAROUSEL: true, VIDEO: true }, mediaRequired: true,
    imageMimes: ['image/jpeg', 'image/webp'], imageMaxBytes: 20 * MB, videoMimes: ['video/mp4', 'video/quicktime', 'video/webm'], videoMaxBytes: 1024 * MB, videoMinSeconds: 3, videoMaxSeconds: 600, carouselMin: 2, carouselMax: 35, mediaByUrl: true,
  },
  YOUTUBE: {
    label: 'YouTube', captionMax: 5000, hashtagsMax: 15, supports: { TEXT: false, IMAGE: false, CAROUSEL: false, VIDEO: true }, mediaRequired: true,
    imageMimes: [], imageMaxBytes: 0, videoMimes: ['video/mp4', 'video/quicktime', 'video/webm'], videoMaxBytes: 2048 * MB, videoMinSeconds: 1, videoMaxSeconds: 43_200, shortVideoMaxSeconds: 60, carouselMin: 0, carouselMax: 0, mediaByUrl: false,
  },
  LINKEDIN: {
    label: 'LinkedIn', captionMax: 3000, hashtagsMax: 30, supports: { TEXT: true, IMAGE: true, CAROUSEL: true, VIDEO: true }, mediaRequired: false,
    imageMimes: ['image/jpeg', 'image/png', 'image/gif'], imageMaxBytes: 8 * MB, videoMimes: ['video/mp4'], videoMaxBytes: 200 * MB, videoMinSeconds: 3, videoMaxSeconds: 600, carouselMin: 2, carouselMax: 20, mediaByUrl: false,
  },
};

/** Normalized publishing error codes shown to people (translated by the web app). */
export const PUBLISH_ERROR_CODES = [
  'ACCOUNT_NOT_CONNECTED', 'ACCOUNT_NOT_AUTHORIZED', 'TOKEN_EXPIRED', 'PERMISSION_MISSING', 'FORMAT_UNSUPPORTED', 'CONTENT_INVALID', 'MEDIA_INVALID', 'MEDIA_URL_NOT_PUBLIC',
  'RATE_LIMITED', 'PLATFORM_ERROR', 'PLATFORM_REJECTED', 'OUTCOME_UNKNOWN', 'NOT_CONFIGURED', 'PROCESSING_TIMEOUT', 'DUPLICATE_PUBLICATION',
] as const;
