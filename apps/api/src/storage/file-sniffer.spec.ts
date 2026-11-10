import { sanitizeFilename, sniffMime } from './file-sniffer';

const b = (...bytes: number[]) => Buffer.from(bytes);
const pad = (buf: Buffer) => Buffer.concat([buf, Buffer.alloc(64)]);

describe('sniffMime', () => {
  it('detects allowed formats by magic bytes', () => {
    expect(sniffMime(pad(b(0xff, 0xd8, 0xff, 0xe0)))).toBe('image/jpeg');
    expect(sniffMime(pad(b(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)))).toBe('image/png');
    expect(sniffMime(pad(Buffer.from('GIF89a')))).toBe('image/gif');
    expect(sniffMime(pad(Buffer.from('RIFF\0\0\0\0WEBPVP8 ', 'latin1')))).toBe('image/webp');
    expect(sniffMime(pad(Buffer.from('\0\0\0\x18ftypisom', 'latin1')))).toBe('video/mp4');
    expect(sniffMime(pad(Buffer.from('\0\0\0\x14ftypqt  ', 'latin1')))).toBe('video/quicktime');
    expect(sniffMime(pad(Buffer.concat([b(0x1a, 0x45, 0xdf, 0xa3), Buffer.from('....B\x82\x84webm', 'latin1')])))).toBe('video/webm');
  });

  it('rejects active or unknown content', () => {
    expect(sniffMime(pad(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg">')))).toBeNull();
    expect(sniffMime(pad(Buffer.from('<!DOCTYPE html><script>')))).toBeNull();
    expect(sniffMime(pad(Buffer.from('%PDF-1.7')))).toBeNull();
    expect(sniffMime(pad(b(0x4d, 0x5a)))).toBeNull(); // Windows executable
    expect(sniffMime(pad(Buffer.concat([b(0x1a, 0x45, 0xdf, 0xa3), Buffer.from('matroska', 'latin1')])))).toBeNull();
    expect(sniffMime(Buffer.alloc(0))).toBeNull();
  });
});

describe('sanitizeFilename', () => {
  it('removes paths and dangerous characters', () => {
    expect(sanitizeFilename('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFilename('C:\\fakepath\\photo<1>.jpg')).toBe('photo1.jpg');
    expect(sanitizeFilename('ok\u0000name.png')).toBe('okname.png');
    expect(sanitizeFilename('')).toBe('file');
  });
});
