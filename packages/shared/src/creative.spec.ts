import { ASPECT_RATIOS, dimensionsFor, IMAGE_TYPES, PLATFORM_ASPECTS, RESOLUTION_KEYS, VIDEO_FORMATS } from './creative';

describe('creative vocabulary', () => {
  it('computes exact, even output sizes for every aspect ratio and resolution', () => {
    expect(dimensionsFor('1:1', 'STANDARD')).toEqual({ width: 1080, height: 1080 });
    expect(dimensionsFor('9:16', 'STANDARD')).toEqual({ width: 608, height: 1080 });
    expect(dimensionsFor('16:9', 'HD')).toEqual({ width: 1920, height: 1080 });
    expect(dimensionsFor('4:5', 'HD')).toEqual({ width: 1536, height: 1920 });
    for (const a of ASPECT_RATIOS) {
      for (const r of RESOLUTION_KEYS) {
        const d = dimensionsFor(a, r);
        expect(d.width % 2).toBe(0);
        expect(d.height % 2).toBe(0);
        expect(Math.max(d.width, d.height)).toBe(r === 'HD' ? 1920 : 1080);
      }
    }
  });
  it('every platform suggests only known aspect ratios and video formats match the platforms', () => {
    for (const list of Object.values(PLATFORM_ASPECTS)) for (const a of list) expect(ASPECT_RATIOS).toContain(a);
    expect(PLATFORM_ASPECTS.TIKTOK).toEqual(['9:16']);
    expect(VIDEO_FORMATS.SHORT_VERTICAL.aspect).toBe('9:16');
    expect(IMAGE_TYPES).toHaveLength(7);
  });
});
