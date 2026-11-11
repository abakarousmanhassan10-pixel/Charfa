import { PLATFORM_CAPABILITIES } from '@touma/shared';
import { codecName } from './probe';
import type { Platform, PublishableContent, ValidationIssue } from './types';

const H264_FAMILY = ['avc1', 'avc2', 'avc3', 'avc4'];
const HEVC = ['hvc1', 'hev1'];

export interface MediaRule {
  /** width / height, inclusive. */
  imageAspect?: [number, number];
  videoAspect?: [number, number];
  imageMinSide?: number;
  imageMaxPixels?: number;
  videoMinSide?: number;
  videoMaxSide?: number;
  videoCodecs?: string[];
  audioCodecs?: string[];
}

/**
 * Per-platform media rules beyond size, type and duration (those live in PLATFORM_CAPABILITIES).
 * Taken from each platform's public publishing documentation and reviewed 2026-11; platforms change these without notice, so the
 * live verification (docs/SOCIAL-PLATFORM-APPROVALS.md) re-checks them with a real upload. A platform answer always wins over this table.
 */
export const MEDIA_RULES: Record<Platform, MediaRule> = {
  INSTAGRAM: { imageAspect: [0.8, 1.91], imageMinSide: 320, videoAspect: [0.5625, 1.91], videoMinSide: 540, videoCodecs: [...H264_FAMILY, ...HEVC], audioCodecs: ['mp4a'] },
  FACEBOOK: { imageMinSide: 200, videoCodecs: [...H264_FAMILY, ...HEVC], audioCodecs: ['mp4a'] },
  TIKTOK: { videoAspect: [0.5, 2], videoMinSide: 360, videoMaxSide: 4096, videoCodecs: [...H264_FAMILY, ...HEVC, 'vp08', 'vp09'], imageMinSide: 100 },
  YOUTUBE: { videoCodecs: [...H264_FAMILY, ...HEVC, 'vp08', 'vp09', 'av01'] },
  LINKEDIN: { imageMaxPixels: 36_152_320, videoAspect: [1 / 2.4, 2.4], videoMinSide: 144, videoMaxSide: 4096, videoCodecs: [...H264_FAMILY], audioCodecs: ['mp4a'] },
};

/** Pixel size, aspect ratio and codec checks, with messages that say what is wrong and what to do. */
export function validateMediaRules(platform: Platform, c: PublishableContent): ValidationIssue[] {
  const R = MEDIA_RULES[platform];
  const label = PLATFORM_CAPABILITIES[platform].label;
  const out: ValidationIssue[] = [];
  const bad = (message: string): ValidationIssue => ({ code: 'MEDIA_INVALID', message });
  c.media.forEach((m, i) => {
    const n = c.media.length > 1 ? `Media ${i + 1}: ` : '';
    const isVideo = m.mimeType.startsWith('video/');
    const w = m.width ?? 0;
    const h = m.height ?? 0;
    const aspect = w > 0 && h > 0 ? w / h : null;
    const side = w > 0 && h > 0 ? Math.min(w, h) : null;
    const range = isVideo ? R.videoAspect : R.imageAspect;
    if (aspect !== null && range && (aspect < range[0] - 0.005 || aspect > range[1] + 0.005)) {
      out.push(bad(`${n}The ${isVideo ? 'video' : 'image'} is ${w}x${h} (aspect ratio ${aspect.toFixed(2)}:1). ${label} accepts ${range[0].toFixed(2)}:1 to ${range[1].toFixed(2)}:1. Crop or resize it.`));
    }
    const minSide = isVideo ? R.videoMinSide : R.imageMinSide;
    if (side !== null && minSide && side < minSide) out.push(bad(`${n}The ${isVideo ? 'video' : 'image'} is ${w}x${h}; ${label} needs at least ${minSide} pixels on its shorter side.`));
    if (side !== null && isVideo && R.videoMaxSide && Math.max(w, h) > R.videoMaxSide) out.push(bad(`${n}The video is ${w}x${h}; ${label} accepts at most ${R.videoMaxSide} pixels on its longer side.`));
    if (!isVideo && R.imageMaxPixels && w * h > R.imageMaxPixels) out.push(bad(`${n}The image has ${(w * h / 1e6).toFixed(1)} megapixels; ${label} accepts at most ${(R.imageMaxPixels / 1e6).toFixed(1)}.`));
    if (isVideo && m.videoCodec && R.videoCodecs && !R.videoCodecs.includes(m.videoCodec)) {
      out.push(bad(`${n}The video uses the ${codecName(m.videoCodec)} codec; ${label} accepts ${[...new Set(R.videoCodecs.map(codecName))].join(', ')}. Re-encode it (H.264 video with AAC audio works everywhere).`));
    }
    if (isVideo && m.audioCodec && R.audioCodecs && !R.audioCodecs.includes(m.audioCodec)) out.push(bad(`${n}The video's audio uses ${codecName(m.audioCodec)}; ${label} accepts ${R.audioCodecs.map(codecName).join(', ')}.`));
  });
  return out;
}

/** The platform-independent part of validation, driven by the limits in @touma/shared (PLATFORM_CAPABILITIES). */
export function validateAgainstLimits(platform: Platform, c: PublishableContent): ValidationIssue[] {
  const L = PLATFORM_CAPABILITIES[platform];
  const out: ValidationIssue[] = [];
  const manual = (message: string): ValidationIssue => ({ code: 'FORMAT_UNSUPPORTED', message, manual: true });
  if (!L.supports[c.kind]) {
    out.push(manual(`${L.label} does not allow publishing ${c.kind.toLowerCase()} posts through its official API. Publish it manually.`));
    return out;
  }
  if (c.kind === 'VIDEO' && c.surface === 'REEL' && platform !== 'INSTAGRAM') out.push(manual(`${L.label} Reels cannot be published through its official API. Publish it manually.`));
  if (c.kind === 'VIDEO' && c.surface === 'SHORT' && platform !== 'YOUTUBE') out.push({ code: 'CONTENT_INVALID', message: 'Shorts exist on YouTube only.' });
  const text = [c.caption, ...c.hashtags.map((h) => `#${h}`)].filter(Boolean).join(' ');
  if (text.length > L.captionMax) out.push({ code: 'CONTENT_INVALID', message: `The text has ${text.length} characters; ${L.label} allows ${L.captionMax}.` });
  if (c.hashtags.length > L.hashtagsMax) out.push({ code: 'CONTENT_INVALID', message: `${L.label} allows at most ${L.hashtagsMax} hashtags.` });
  if (c.kind === 'TEXT' && !c.caption.trim()) out.push({ code: 'CONTENT_INVALID', message: 'The text is empty.' });
  if (c.kind !== 'TEXT' && c.media.length === 0) out.push({ code: 'MEDIA_INVALID', message: 'This post needs media.' });
  if (c.kind === 'TEXT' && c.media.length > 0) out.push({ code: 'CONTENT_INVALID', message: 'A text post cannot carry media.' });
  if (c.kind === 'IMAGE' && c.media.length !== 1) out.push({ code: 'MEDIA_INVALID', message: 'An image post needs exactly one image.' });
  if (c.kind === 'VIDEO' && c.media.length !== 1) out.push({ code: 'MEDIA_INVALID', message: 'A video post needs exactly one video.' });
  if (c.kind === 'CAROUSEL' && (c.media.length < L.carouselMin || c.media.length > L.carouselMax)) out.push({ code: 'MEDIA_INVALID', message: `A carousel on ${L.label} needs ${L.carouselMin} to ${L.carouselMax} items.` });
  for (const m of c.media) {
    const isImage = m.mimeType.startsWith('image/');
    const isVideo = m.mimeType.startsWith('video/');
    if (c.kind === 'VIDEO' && !isVideo) out.push({ code: 'MEDIA_INVALID', message: 'A video post needs a video file.' });
    if ((c.kind === 'IMAGE' || c.kind === 'CAROUSEL') && !isImage && !(c.kind === 'CAROUSEL' && isVideo)) out.push({ code: 'MEDIA_INVALID', message: 'Images are required for this post.' });
    if (isImage && !L.imageMimes.includes(m.mimeType)) out.push({ code: 'MEDIA_INVALID', message: `${L.label} accepts these image types: ${L.imageMimes.join(', ') || 'none'} (this file is ${m.mimeType}).` });
    if (isImage && m.sizeBytes > L.imageMaxBytes) out.push({ code: 'MEDIA_INVALID', message: `An image is larger than ${Math.round(L.imageMaxBytes / 1048576)} MB.` });
    if (isVideo && !L.videoMimes.includes(m.mimeType)) out.push({ code: 'MEDIA_INVALID', message: `${L.label} accepts these video types: ${L.videoMimes.join(', ')} (this file is ${m.mimeType}).` });
    if (isVideo && m.sizeBytes > L.videoMaxBytes) out.push({ code: 'MEDIA_INVALID', message: `A video is larger than ${Math.round(L.videoMaxBytes / 1048576)} MB.` });
    if (isVideo && m.durationSeconds != null) {
      if (m.durationSeconds < L.videoMinSeconds) out.push({ code: 'MEDIA_INVALID', message: `A video must last at least ${L.videoMinSeconds} s.` });
      const max = c.surface === 'SHORT' || c.surface === 'REEL' ? (L.shortVideoMaxSeconds ?? L.videoMaxSeconds) : L.videoMaxSeconds;
      if (m.durationSeconds > max) out.push({ code: 'MEDIA_INVALID', message: `A video must not last more than ${max} s on ${L.label}${c.surface === 'SHORT' ? ' to be a Short' : ''}.` });
    }
  }
  out.push(...validateMediaRules(platform, c));
  return out;
}

/** Caption + hashtags + call to action as one text. */
export function composeText(c: PublishableContent, opts: { hashtagStyle?: (tag: string) => string } = {}): string {
  const tags = c.hashtags.map((h) => (opts.hashtagStyle ? opts.hashtagStyle(h) : `#${h.replace(/^#/, '')}`));
  return [c.caption.trim(), c.callToAction?.trim() && !c.caption.includes(c.callToAction.trim()) ? c.callToAction.trim() : '', tags.join(' ')].filter(Boolean).join('\n\n');
}
