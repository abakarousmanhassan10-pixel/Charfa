import sharp from 'sharp';
import type { AllowedMimeType } from '@touma/shared';

export interface ProcessedImage {
  data: Buffer;
  width: number;
  height: number;
  thumbnail: Buffer;
}

export class ImageRejectedError extends Error {
  constructor(
    readonly code: 'IMAGE_CORRUPT' | 'IMAGE_DIMENSIONS',
    message: string,
  ) {
    super(message);
    this.name = 'ImageRejectedError';
  }
}

export const THUMBNAIL_SIZE = 480;

/**
 * Decodes and re-encodes every uploaded image:
 *  - full decode (corrupt or polyglot files fail here; trailing data after the image is discarded);
 *  - decompression-bomb guard (limitInputPixels);
 *  - orientation applied, then ALL metadata removed (EXIF incl. GPS, XMP, IPTC, comments);
 *  - re-encoded in the same format so the stored bytes are produced by our encoder only;
 *  - a WebP thumbnail (first frame for animations).
 */
export async function processImage(input: Buffer, mime: AllowedMimeType, maxPixels: number): Promise<ProcessedImage> {
  const animated = mime === 'image/gif' || mime === 'image/webp';
  const open = () => sharp(input, { limitInputPixels: maxPixels, failOn: 'error', animated });
  let meta: sharp.Metadata;
  try {
    meta = await open().metadata();
  } catch (err) {
    const msg = (err as Error).message;
    if (/pixel limit/i.test(msg)) throw new ImageRejectedError('IMAGE_DIMENSIONS', 'Image dimensions exceed the allowed limit');
    throw new ImageRejectedError('IMAGE_CORRUPT', 'The image could not be decoded');
  }
  if (!meta.width || !meta.height) throw new ImageRejectedError('IMAGE_CORRUPT', 'The image has no dimensions');
  if (meta.width > 20000 || (meta.pageHeight ?? meta.height) > 20000) throw new ImageRejectedError('IMAGE_DIMENSIONS', 'Image dimensions exceed 20000 px');

  try {
    // rotate() with no argument applies EXIF orientation; output metadata is stripped by default.
    let pipeline = open().rotate();
    pipeline =
      mime === 'image/jpeg'
        ? pipeline.jpeg({ quality: 86, mozjpeg: true })
        : mime === 'image/png'
          ? pipeline.png({ compressionLevel: 9, adaptiveFiltering: true })
          : mime === 'image/webp'
            ? pipeline.webp({ quality: 86 })
            : pipeline.gif();
    const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });
    const thumbnail = await sharp(input, { limitInputPixels: maxPixels, failOn: 'error' })
      .rotate()
      .resize(THUMBNAIL_SIZE, THUMBNAIL_SIZE, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 78 })
      .toBuffer();
    return { data, width: info.width, height: info.pageHeight ?? info.height, thumbnail };
  } catch {
    throw new ImageRejectedError('IMAGE_CORRUPT', 'The image could not be processed');
  }
}
