import sharp from 'sharp';
import { BRAND_FONTS, type BrandFont, type LogoPlacement, type OverlayPosition } from '@touma/shared';

/**
 * Deterministic image composition done by TOUMA, not by a model:
 *  - cutting the merchant's product out of its photo,
 *  - placing those exact pixels onto a generated scene (so the product is never repainted),
 *  - drawing the merchant's text and logo.
 */

export interface ProductCutout {
  /** RGBA PNG, trimmed to the product. */
  png: Buffer;
  width: number;
  height: number;
  method: 'alpha' | 'uniform-background';
  /** Share of the photo covered by the product (0-1). */
  coverage: number;
}

const WORK_MAX = 1600;
/** Colour distance (per channel) under which a pixel counts as background, fully / not at all transparent in between. */
const TOL_LOW = 14;
const TOL_HIGH = 34;

/**
 * Cuts the product out of a photo. Works when the photo already has a transparent background, or a plain
 * (near-uniform) one such as a studio backdrop. Returns null when the product cannot be separated reliably:
 * the caller must then say so instead of guessing.
 */
export async function extractProduct(source: Buffer, maxPixels = 40_000_000): Promise<ProductCutout | null> {
  const { data, info } = await sharp(source, { limitInputPixels: maxPixels, failOn: 'error' })
    .rotate()
    .resize(WORK_MAX, WORK_MAX, { fit: 'inside', withoutEnlargement: true })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const w = info.width;
  const h = info.height;
  const n = w * h;
  const alpha = new Uint8Array(n);

  let translucent = 0;
  for (let i = 0; i < n; i++) if (data[i * 4 + 3]! < 250) translucent++;

  let method: ProductCutout['method'];
  if (translucent / n >= 0.05) {
    for (let i = 0; i < n; i++) alpha[i] = data[i * 4 + 3]!;
    method = 'alpha';
  } else {
    // The backdrop colour is the median of the photo's border.
    const samples: number[] = [];
    const ring = 2;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (y < ring || y >= h - ring || x < ring || x >= w - ring) samples.push((y * w + x) * 4);
      }
    }
    const median = (c: number) => {
      const v = samples.map((o) => data[o + c]!).sort((a, b) => a - b);
      return v[Math.floor(v.length / 2)]!;
    };
    const bg = [median(0), median(1), median(2)] as const;
    const dist = (o: number) => Math.max(Math.abs(data[o]! - bg[0]), Math.abs(data[o + 1]! - bg[1]), Math.abs(data[o + 2]! - bg[2]));
    const nearBorder = samples.filter((o) => dist(o) <= TOL_HIGH).length / samples.length;
    if (nearBorder < 0.9) return null; // busy background: not separable by colour

    const isBg = new Uint8Array(n);
    const stack: number[] = [];
    const tryPush = (p: number) => {
      if (!isBg[p] && dist(p * 4) <= TOL_HIGH) {
        isBg[p] = 1;
        stack.push(p);
      }
    };
    for (let x = 0; x < w; x++) {
      tryPush(x);
      tryPush((h - 1) * w + x);
    }
    for (let y = 0; y < h; y++) {
      tryPush(y * w);
      tryPush(y * w + (w - 1));
    }
    while (stack.length) {
      const p = stack.pop()!;
      const x = p % w;
      const y = (p - x) / w;
      if (x > 0) tryPush(p - 1);
      if (x < w - 1) tryPush(p + 1);
      if (y > 0) tryPush(p - w);
      if (y < h - 1) tryPush(p + w);
    }
    for (let p = 0; p < n; p++) {
      if (!isBg[p]) alpha[p] = 255;
      else {
        const d = dist(p * 4);
        alpha[p] = d <= TOL_LOW ? 0 : Math.round((255 * (d - TOL_LOW)) / (TOL_HIGH - TOL_LOW));
      }
    }
    method = 'uniform-background';
  }

  let count = 0;
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (alpha[y * w + x]! > 16) {
        count++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  const coverage = count / n;
  if (maxX < 0 || coverage < 0.03 || coverage > 0.92) return null;

  const pad = 2;
  const x0 = Math.max(0, minX - pad);
  const y0 = Math.max(0, minY - pad);
  const cw = Math.min(w, maxX + pad + 1) - x0;
  const ch = Math.min(h, maxY + pad + 1) - y0;
  const out = Buffer.alloc(cw * ch * 4);
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const src = (y0 + y) * w + (x0 + x);
      const o = (y * cw + x) * 4;
      out[o] = data[src * 4]!;
      out[o + 1] = data[src * 4 + 1]!;
      out[o + 2] = data[src * 4 + 2]!;
      out[o + 3] = alpha[src]!;
    }
  }
  const png = await sharp(out, { raw: { width: cw, height: ch, channels: 4 } }).png().toBuffer();
  return { png, width: cw, height: ch, method, coverage };
}

// ─── Composition ──────────────────────────────────────────────────────────────

export interface CompositeOptions {
  /** The generated scene. It is resized to cover the canvas. */
  background: Buffer;
  cutout: ProductCutout;
  width: number;
  height: number;
  anchor?: 'CENTER' | 'LOWER_CENTER';
  /** Keep the product clear of the area reserved for overlay text. */
  avoid?: OverlayPosition | null;
  shadow?: boolean;
  /** Force a scale (1 = the product's own pixels). Default: fit the product into the frame. */
  fixedScale?: number;
}

export interface CompositeResult {
  image: Buffer;
  placement: { left: number; top: number; width: number; height: number; scale: number };
}

export async function fitCover(input: Buffer, width: number, height: number): Promise<Buffer> {
  return sharp(input).resize(width, height, { fit: 'cover', position: 'centre' }).removeAlpha().png().toBuffer();
}

export async function compositeProduct(o: CompositeOptions): Promise<CompositeResult> {
  const { width: w, height: h } = o;
  const base = await fitCover(o.background, w, h);
  const top = o.avoid === 'TOP' ? h * 0.24 : h * 0.07;
  const bottom = o.avoid === 'BOTTOM' ? h * 0.24 : h * 0.07;
  const availH = h - top - bottom;
  const availW = w * 0.86;
  const scale = o.fixedScale ?? Math.min((availW * 0.9) / o.cutout.width, (availH * 0.88) / o.cutout.height, 2.5);
  const pw = Math.max(1, Math.round(o.cutout.width * scale));
  const ph = Math.max(1, Math.round(o.cutout.height * scale));
  const left = Math.round((w - pw) / 2);
  const y = o.anchor === 'LOWER_CENTER' ? Math.round(top + availH - ph - availH * 0.04) : Math.round(top + (availH - ph) / 2);
  const product = scale === 1 ? o.cutout.png : await sharp(o.cutout.png).resize(pw, ph, { kernel: 'lanczos3' }).png().toBuffer();

  const layers: sharp.OverlayOptions[] = [];
  if (o.shadow !== false) {
    const rx = Math.round(pw * 0.46);
    const ry = Math.max(6, Math.round(ph * 0.045));
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><defs><filter id="b" x="-30%" y="-300%" width="160%" height="700%"><feGaussianBlur stdDeviation="${Math.max(4, Math.round(ph * 0.03))}"/></filter></defs><ellipse cx="${left + pw / 2}" cy="${y + ph - ry * 0.4}" rx="${rx}" ry="${ry}" fill="#000" fill-opacity="0.34" filter="url(#b)"/></svg>`;
    layers.push({ input: Buffer.from(svg), top: 0, left: 0 });
  }
  layers.push({ input: product, left, top: y });
  const image = await sharp(base).composite(layers).png().toBuffer();
  return { image, placement: { left, top: y, width: pw, height: ph, scale } };
}

// ─── Text and logo ────────────────────────────────────────────────────────────

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** A safe CSS font-family for an SVG overlay: only names from the brand font list, always with a generic fallback. */
export function fontFamily(name?: string | null): string {
  if (name && Object.prototype.hasOwnProperty.call(BRAND_FONTS, name)) return `'${name}', ${BRAND_FONTS[name as BrandFont]}`;
  return 'sans-serif';
}

function wrap(text: string, maxChars: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (!line) line = word;
    else if ((line + ' ' + word).length <= maxChars) line += ' ' + word;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

export interface OverlayOptions {
  text: string;
  position: OverlayPosition;
  width: number;
  height: number;
  fontFamily?: string;
  /** #RRGGBB. Default: chosen for contrast with the picture. */
  textColor?: string | null;
  bandColor?: string | null;
}

async function regionLuminance(base: Buffer, top: number, height: number, width: number): Promise<number> {
  const stats = await sharp(base).extract({ left: 0, top: Math.max(0, Math.round(top)), width, height: Math.max(1, Math.round(height)) }).stats();
  const [r, g, b] = stats.channels.map((c) => c.mean);
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
}

/** Draws the merchant's text on a contrast band. Wrapping, sizing and right-to-left scripts are handled here. */
export async function renderOverlay(base: Buffer, o: OverlayOptions): Promise<Buffer> {
  const { width: w, height: h } = o;
  let size = Math.max(24, Math.round(w * 0.066));
  let lines: string[] = [];
  for (let attempt = 0; attempt < 8; attempt++) {
    lines = wrap(o.text.trim(), Math.floor((w * 0.84) / (size * 0.56)));
    if (lines.length <= 4 || size <= 20) break;
    size = Math.round(size * 0.86);
  }
  if (lines.length > 4) {
    lines = lines.slice(0, 4);
    lines[3] = lines[3]!.slice(0, Math.max(1, lines[3]!.length - 1)) + '…';
  }
  const lineH = Math.round(size * 1.25);
  const pad = Math.round(size * 0.6);
  const bandH = lines.length * lineH + 2 * pad;
  const y0 = o.position === 'TOP' ? Math.round(h * 0.05) : o.position === 'CENTER' ? Math.round((h - bandH) / 2) : Math.round(h - bandH - h * 0.05);

  const lum = await regionLuminance(base, y0, bandH, w);
  const band = o.bandColor ?? (lum > 150 ? '#000000' : '#ffffff');
  const text = o.textColor ?? (o.bandColor ? (parseInt(o.bandColor.slice(1, 3), 16) * 0.3 + parseInt(o.bandColor.slice(3, 5), 16) * 0.6 + parseInt(o.bandColor.slice(5, 7), 16) * 0.1 > 140 ? '#111111' : '#ffffff') : band === '#000000' ? '#ffffff' : '#111111');
  const rtl = /[֐-ࣿ]/.test(o.text);
  const tspans = lines.map((l, i) => `<tspan x="${w / 2}" y="${y0 + pad + (i + 1) * lineH - Math.round(lineH * 0.25)}">${esc(l)}</tspan>`).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect x="0" y="${y0}" width="${w}" height="${bandH}" fill="${band}" fill-opacity="0.72"/><text font-family="${esc(o.fontFamily ?? 'sans-serif')}" font-size="${size}" font-weight="700" fill="${text}" text-anchor="middle"${rtl ? ' direction="rtl" unicode-bidi="plaintext"' : ''}>${tspans}</text></svg>`;
  return sharp(base).composite([{ input: Buffer.from(svg), top: 0, left: 0 }]).png().toBuffer();
}

/** Puts the business logo in a corner, at about 16% of the image width. */
export async function placeLogo(base: Buffer, logo: Buffer, placement: Exclude<LogoPlacement, 'NONE'>, width: number, height: number): Promise<Buffer> {
  const box = Math.round(width * 0.16);
  const resized = await sharp(logo).resize(box, box, { fit: 'inside', withoutEnlargement: false }).png().toBuffer();
  const meta = await sharp(resized).metadata();
  const margin = Math.round(width * 0.04);
  const lw = meta.width ?? box;
  const lh = meta.height ?? box;
  const left = placement.endsWith('LEFT') ? margin : width - lw - margin;
  const top = placement.startsWith('TOP') ? margin : height - lh - margin;
  return sharp(base).composite([{ input: resized, left, top }]).png().toBuffer();
}

/** Final delivery format: JPEG for photographic results. */
export async function toJpeg(input: Buffer, quality = 90): Promise<Buffer> {
  return sharp(input).removeAlpha().jpeg({ quality, mozjpeg: true }).toBuffer();
}

/** Resizes to the exact requested size; reports whether that meant enlarging the provider's output. */
export async function resizeExact(input: Buffer, width: number, height: number): Promise<{ data: Buffer; upscaled: boolean }> {
  const meta = await sharp(input).metadata();
  const upscaled = (meta.width ?? 0) < width || (meta.height ?? 0) < height;
  return { data: await sharp(input).resize(width, height, { fit: 'cover', position: 'centre', kernel: 'lanczos3' }).removeAlpha().png().toBuffer(), upscaled };
}
