/**
 * Reads what a media file really is from its bytes (not from its name or the browser-supplied type).
 * MP4/MOV: duration (mvhd), pixel size (tkhd), codecs (stsd). JPEG/PNG: pixel size.
 */
export interface MediaFacts {
  container: 'mp4' | 'mov' | 'jpeg' | 'png' | 'unknown';
  width?: number;
  height?: number;
  durationSeconds?: number;
  videoCodec?: string;
  audioCodec?: string;
}

const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl']);

function boxes(b: Buffer, start: number, end: number, visit: (type: string, from: number, to: number, depth: number) => void, depth = 0) {
  let p = start;
  while (p + 8 <= end) {
    let size = b.readUInt32BE(p);
    const type = b.toString('latin1', p + 4, p + 8);
    let header = 8;
    if (size === 1 && p + 16 <= end) {
      size = Number(b.readBigUInt64BE(p + 8));
      header = 16;
    } else if (size === 0) size = end - p;
    if (size < header || p + size > end) break;
    visit(type, p + header, p + size, depth);
    if (CONTAINERS.has(type)) boxes(b, p + header, p + size, visit, depth + 1);
    p += size;
  }
}

export function probeMedia(b: Buffer): MediaFacts {
  if (b.length >= 24 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { container: 'png', width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) return probeJpeg(b);
  if (b.length >= 12 && b.toString('latin1', 4, 8) === 'ftyp') return probeMp4(b);
  return { container: 'unknown' };
}

function probeJpeg(b: Buffer): MediaFacts {
  let p = 2;
  while (p + 9 < b.length) {
    if (b[p] !== 0xff) { p++; continue; }
    const marker = b[p + 1]!;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { p += 2; continue; }
    const len = b.readUInt16BE(p + 2);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { container: 'jpeg', height: b.readUInt16BE(p + 5), width: b.readUInt16BE(p + 7) };
    p += 2 + len;
  }
  return { container: 'jpeg' };
}

function probeMp4(b: Buffer): MediaFacts {
  const brand = b.toString('latin1', 8, 12);
  const out: MediaFacts = { container: brand.startsWith('qt') ? 'mov' : 'mp4' };
  let handler = '';
  boxes(b, 0, b.length, (type, from, to) => {
    if (type === 'mvhd') {
      const v = b[from]!;
      const scale = v === 1 ? b.readUInt32BE(from + 20) : b.readUInt32BE(from + 12);
      const dur = v === 1 ? Number(b.readBigUInt64BE(from + 24)) : b.readUInt32BE(from + 16);
      if (scale > 0) out.durationSeconds = Math.round((dur / scale) * 1000) / 1000;
    } else if (type === 'hdlr') {
      handler = b.toString('latin1', from + 8, from + 12);
    } else if (type === 'tkhd') {
      const v = b[from]!;
      const o = from + (v === 1 ? 88 : 76); // width and height are 16.16 fixed point at the end of the box
      if (o + 8 <= to) {
        const w = b.readUInt32BE(o) / 65536;
        const h = b.readUInt32BE(o + 4) / 65536;
        if (w > 0 && h > 0 && !out.width) { out.width = Math.round(w); out.height = Math.round(h); }
      }
    } else if (type === 'stsd' && to - from >= 16) {
      const codec = b.toString('latin1', from + 12, from + 16);
      if (/^(avc[1-4]|hvc1|hev1|vp0[89]|av01|mp4v|apch|apcn|ap4h|jpeg)$/.test(codec)) out.videoCodec = codec;
      else if (/^(mp4a|ac-3|ec-3|opus|alac|sowt|lpcm)$/.test(codec)) out.audioCodec = codec;
    }
  });
  void handler;
  return out;
}

/** Friendly names for the codec fourccs, for error messages. */
export function codecName(fourcc: string): string {
  if (/^avc/.test(fourcc)) return 'H.264';
  if (/^(hvc1|hev1)$/.test(fourcc)) return 'H.265/HEVC';
  if (/^vp0/.test(fourcc)) return 'VP9';
  if (fourcc === 'av01') return 'AV1';
  if (fourcc === 'mp4a') return 'AAC';
  if (fourcc === 'opus') return 'Opus';
  return fourcc;
}
