/** Real, minimal binary fixtures (generated in code; no files from the internet). */
import { deflateSync } from 'zlib';

function crc32(buf: Buffer) {
  let c: number;
  const table: number[] = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/** A valid RGB PNG of the given size (solid colour). */
export function png(width = 4, height = 3, padBytes = 0): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const raw = Buffer.alloc((width * 3 + 1) * height, 0x7f);
  for (let y = 0; y < height; y++) raw[y * (width * 3 + 1)] = 0;
  const parts = [
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
  ];
  if (padBytes > 0) parts.push(chunk('tEXt', Buffer.alloc(padBytes, 0x61)));
  parts.push(chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
}

/** MP4 header (ftyp box) followed by filler: enough for type detection and size limits. */
export function mp4(totalBytes = 4096): Buffer {
  const ftyp = Buffer.from('\0\0\0\x18ftypisom\0\0\x02\0isomiso2', 'latin1');
  return Buffer.concat([ftyp, Buffer.alloc(Math.max(0, totalBytes - ftyp.length), 0)]);
}

export const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><rect/></svg>');
export const html = Buffer.from('<!doctype html><script>alert(1)</script>');
