import { AI_FORMATS, FORMAT_RULES, FORMATS_BY_PLATFORM } from './ai';

describe('AI format rules', () => {
  it('every format has a rule and belongs to exactly one platform group', () => {
    const grouped = Object.values(FORMATS_BY_PLATFORM).flat();
    expect(grouped.sort()).toEqual([...AI_FORMATS].sort());
    for (const f of AI_FORMATS) {
      const rule = FORMAT_RULES[f];
      const group = Object.entries(FORMATS_BY_PLATFORM).find(([, fs]) => fs.includes(f))![0];
      expect(rule.platform ?? 'ANY').toBe(group);
    }
  });
  it('respects key platform limits', () => {
    expect(FORMAT_RULES.YOUTUBE_VIDEO.maxTitleChars).toBe(100);
    expect(FORMAT_RULES.INSTAGRAM_CAPTION.maxCaptionChars).toBe(2200);
    expect(FORMAT_RULES.INSTAGRAM_CAPTION.maxHashtags).toBe(30);
    expect(FORMAT_RULES.INSTAGRAM_CAROUSEL.slides).toEqual({ min: 2, max: 10 });
    expect(FORMAT_RULES.YOUTUBE_SHORTS_SCRIPT.durationSeconds!.max).toBeLessThanOrEqual(60);
  });
});
