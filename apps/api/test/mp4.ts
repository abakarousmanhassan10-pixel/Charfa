/** Builds a minimal but structurally valid MP4 (ftyp + moov with mvhd, a video track and an audio track) that the media probe reads. */
const box = (type: string, ...parts: Buffer[]) => {
  const body = Buffer.concat(parts);
  const h = Buffer.alloc(8);
  h.writeUInt32BE(8 + body.length, 0);
  h.write(type, 4, 'latin1');
  return Buffer.concat([h, body]);
};
const u32 = (...v: number[]) => {
  const b = Buffer.alloc(4 * v.length);
  v.forEach((x, i) => b.writeUInt32BE(x, i * 4));
  return b;
};
export function buildMp4(o: { w?: number; h?: number; seconds?: number; codec?: string; audio?: string } = {}) {
  const { w = 1080, h = 1920, seconds = 20, codec = 'avc1', audio = 'mp4a' } = o;
  const mvhd = box('mvhd', u32(0, 0, 0, 1000, seconds * 1000), Buffer.alloc(80));
  const tkhd = box('tkhd', Buffer.concat([u32(0x0f, 0, 0, 1, 0, seconds * 1000), Buffer.alloc(52), u32(w * 65536, h * 65536)]));
  const stsd = (cc: string) => box('stsd', u32(0, 1), box(cc, Buffer.alloc(8)));
  const trak = (cc: string, head?: Buffer) => box('trak', ...(head ? [head] : []), box('mdia', box('minf', box('stbl', stsd(cc)))));
  return Buffer.concat([box('ftyp', Buffer.from('isom0000isom', 'latin1')), box('moov', mvhd, trak(codec, tkhd), trak(audio)), box('mdat', Buffer.alloc(2048, 1))]);
}
