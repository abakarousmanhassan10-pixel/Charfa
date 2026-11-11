import { PLATFORM_CAPABILITIES } from '@touma/shared';
import type { Platform, PublishableContent, ValidationIssue } from './types';

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
  return out;
}

/** Caption + hashtags + call to action as one text. */
export function composeText(c: PublishableContent, opts: { hashtagStyle?: (tag: string) => string } = {}): string {
  const tags = c.hashtags.map((h) => (opts.hashtagStyle ? opts.hashtagStyle(h) : `#${h.replace(/^#/, '')}`));
  return [c.caption.trim(), c.callToAction?.trim() && !c.caption.includes(c.callToAction.trim()) ? c.callToAction.trim() : '', tags.join(' ')].filter(Boolean).join('\n\n');
}
