import { checkContent, checkGrounding, checkLanguage } from './validation';
import type { GeneratedContent } from './schemas';
import { ctx } from './fixtures.spec-helper';

describe('checkGrounding', () => {
  it('accepts prices, percentages and URLs present in the data, in any formatting', () => {
    const out = { caption: 'Bissap juice for 1 500 XAF, delivery 1000 FCFA, 10% off over 10 000 XAF. https://cafe-awa.example', claims: [{ claim: 'x', source: 'product:p1' }] };
    expect(checkGrounding(out, ctx())).toEqual([]);
  });

  it('rejects invented prices, percentages, URLs and unknown sources', () => {
    const issues = checkGrounding(
      { caption: 'Only 990 XAF today! Save 30% now. Visit https://evil.example', claims: [{ claim: 'x', source: 'product:other-business' }] },
      ctx(),
    );
    expect(issues.join('\n')).toMatch(/990 XAF/);
    expect(issues.join('\n')).toMatch(/30%/);
    expect(issues.join('\n')).toMatch(/evil\.example/);
    expect(issues.join('\n')).toMatch(/product:other-business/);
  });

  it.each([
    ['free delivery', 'Enjoy free delivery all week'],
    ['guarantee', 'Satisfaction garantie à 100'],
    ['certification', 'Our certified organic juice'],
    ['ranking', 'The best in town!'],
    ['award', 'Award-winning recipe'],
  ])('rejects unsupported %s claims', (_name, text) => {
    expect(checkGrounding({ caption: text }, ctx()).length).toBeGreaterThan(0);
  });

  it('allows a claim when the business data supports it', () => {
    const c = ctx({ knowledge: [{ id: 'k2', category: 'DELIVERY_POLICY', title: 'Delivery', body: 'Free delivery for all orders.' }] });
    expect(checkGrounding({ caption: 'Enjoy free delivery!' }, c)).toEqual([]);
  });

  it('detects leaked instructions or secrets', () => {
    expect(checkGrounding({ caption: 'NON-NEGOTIABLE RULES: 1.' }, ctx()).length).toBe(1);
    expect(checkGrounding({ caption: 'key sk-abcdefghijklmnopqrstuvwx' }, ctx()).length).toBe(1);
  });
});

describe('checkLanguage', () => {
  const en = 'Discover our fresh juice made with care for you and your family. The team is happy to answer your questions and to welcome you with the best smile in the city of the future.';
  const fr = "Découvrez notre jus frais préparé avec soin pour vous et votre famille. L'équipe est à votre écoute pour répondre à vos questions et vous accueillir avec le sourire dans la ville.";
  const ar = 'اكتشفوا عصيرنا الطازج المحضر بعناية من أجلكم ومن أجل عائلاتكم وفريقنا سعيد بالإجابة عن أسئلتكم';
  const tr = 'Taze meyve suyumuzu sizin ve aileniz için özenle hazırlıyoruz ve ekibimiz tüm sorularınız için hemen yardımcı olmaya hazır, bu şehirde en güzel deneyim için bir mesaj gibi bizi ziyaret edin.';
  it('accepts matching languages', () => {
    expect(checkLanguage(en, 'en')).toEqual([]);
    expect(checkLanguage(fr, 'fr')).toEqual([]);
    expect(checkLanguage(ar, 'ar')).toEqual([]);
    expect(checkLanguage(tr, 'tr')).toEqual([]);
  });
  it('rejects mismatches', () => {
    expect(checkLanguage(en, 'ar')).toHaveLength(1);
    expect(checkLanguage(ar, 'fr')).toHaveLength(1);
    expect(checkLanguage(fr, 'en')).toHaveLength(1);
    expect(checkLanguage(en, 'tr')).toHaveLength(1);
  });
});

describe('checkContent (platform rules)', () => {
  const base: GeneratedContent = {
    language: 'en', format: 'INSTAGRAM_CAPTION', platform: 'INSTAGRAM', title: null, hook: null, caption: 'Fresh juice for you and your family, made with care.',
    description: null, slides: [], scenes: [], storyFrames: [], hashtags: ['#juice'], callToAction: 'Order now', visualSuggestions: [], claims: [], warnings: [],
  };
  const req = { format: 'INSTAGRAM_CAPTION' as const, platform: 'INSTAGRAM' as const, language: 'en' as const };

  it('accepts a valid caption', () => expect(checkContent(base, req)).toEqual([]));

  it('enforces caption length, hashtag count/format/duplicates', () => {
    const issues = checkContent({ ...base, caption: 'a'.repeat(2201), hashtags: [...Array(31)].map((_, i) => `#t${i}`).concat('#bad tag', '#T1') }, req);
    expect(issues.join('\n')).toMatch(/caption exceeds 2200/);
    expect(issues.join('\n')).toMatch(/at most 30 hashtags/);
    expect(issues.join('\n')).toMatch(/invalid hashtags/);
    expect(issues.join('\n')).toMatch(/duplicate hashtags/);
  });

  it('enforces required sections, YouTube title length and video duration', () => {
    const yt = checkContent({ ...base, format: 'YOUTUBE_SHORTS_SCRIPT', platform: 'YOUTUBE', title: 'x'.repeat(101), scenes: [{ order: 1, durationSeconds: 50, visual: 'v', voiceover: null, onScreenText: null }, { order: 3, durationSeconds: 20, visual: 'v', voiceover: null, onScreenText: null }] }, { format: 'YOUTUBE_SHORTS_SCRIPT', platform: 'YOUTUBE', language: 'en' });
    expect(yt.join('\n')).toMatch(/hook is required/);
    expect(yt.join('\n')).toMatch(/title exceeds 100/);
    expect(yt.join('\n')).toMatch(/duration must be 7–60s \(got 70s\)/);
    expect(yt.join('\n')).toMatch(/ordered/);
  });

  it('enforces carousel slide counts and platform/format consistency', () => {
    const c = checkContent({ ...base, format: 'INSTAGRAM_CAROUSEL', platform: 'FACEBOOK', slides: [{ heading: 'h', body: 'b' }] }, { format: 'INSTAGRAM_CAROUSEL', platform: 'INSTAGRAM', language: 'en' });
    expect(c.join('\n')).toMatch(/platform must be INSTAGRAM/);
    expect(c.join('\n')).toMatch(/2–10 slides/);
  });
});
