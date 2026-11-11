import type { AllowedMimeType } from '@touma/shared';

/**
 * Detects the real file type from its first bytes (magic numbers). The declared Content-Type and
 * file extension are never trusted: an upload is accepted only if the sniffed type is allowed AND
 * equals the declared type. SVG, HTML and other active formats are never accepted.
 */
export function sniffMime(head: Buffer): AllowedMimeType | null {
  const at = (offset: number, bytes: number[]) => bytes.every((b, i) => head[offset + i] === b);
  const ascii = (offset: number, text: string) => head.subarray(offset, offset + text.length).toString('latin1') === text;

  if (at(0, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (at(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (ascii(0, 'GIF87a') || ascii(0, 'GIF89a')) return 'image/gif';
  if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return 'image/webp';
  if (ascii(4, 'ftyp')) {
    const brand = head.subarray(8, 12).toString('latin1');
    return brand === 'qt  ' ? 'video/quicktime' : 'video/mp4';
  }
  if (at(0, [0x1a, 0x45, 0xdf, 0xa3])) {
    // EBML container: accept only if the DocType is "webm" (not generic Matroska).
    return head.subarray(0, 64).includes(Buffer.from('webm', 'latin1')) ? 'video/webm' : null;
  }
  return null;
}

/** Safe, display-only filename: strips paths, control chars and anything outside a conservative set. */
export function sanitizeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? 'file';
  const cleaned = base
    .normalize('NFKC')
    // eslint-disable-next-line no-control-regex -- control characters are removed from filenames on purpose
    .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
  return cleaned || 'file';
}
