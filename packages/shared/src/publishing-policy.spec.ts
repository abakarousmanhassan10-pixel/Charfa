import { DEFAULT_HOURS, classifyPublication, validateHours, validatePolicyDraft, withinHours, platformFacts, type ClassifyInput } from './publishing-policy';

const base: ClassifyInput = {
  mode: 'AUTO', platform: 'INSTAGRAM', contentKind: 'IMAGE', title: 'Bissap', caption: 'Fresh bissap juice, served cold. Come and taste it today.', hashtags: ['#bissap'],
  allowedContentTypes: ['IMAGE', 'VIDEO'], scheduledAt: new Date('2026-11-16T10:00:00Z'), timezone: 'UTC', hours: DEFAULT_HOURS, postsThatDay: 0, maxPostsPerDay: 3, platformConfirmationMissing: false,
};
const c = (o: Partial<ClassifyInput> = {}) => classifyPublication({ ...base, ...o });
const codes = (o: Partial<ClassifyInput>) => c(o).reasons.map((r) => r.code);

describe('classifyPublication', () => {
  it('ordinary content is LOW_RISK in AUTO and HYBRID', () => {
    expect(c().risk).toBe('LOW_RISK');
    expect(c({ mode: 'HYBRID' }).risk).toBe('LOW_RISK');
  });
  it('MANUAL never auto-approves', () => expect(c({ mode: 'MANUAL' }).risk).toBe('REVIEW_REQUIRED'));
  it('unusual promotions: review in HYBRID, allowed in AUTO', () => {
    const o = { caption: 'Huge sale: 70% off everything this week!' };
    expect(codes(o)).toContain('UNUSUAL_PROMOTION');
    expect(c({ ...o, mode: 'HYBRID' }).risk).toBe('REVIEW_REQUIRED');
    expect(c({ ...o, mode: 'AUTO' }).risk).toBe('LOW_RISK');
  });
  it('sensitive claims, misleading wording and personal data need review even in AUTO', () => {
    for (const caption of ['This juice cures diabetes and heals everything.', '100% guaranteed results or nothing', 'Call me on +235 66 12 34 56 or mail a@b.com', 'Guaranteed returns on your investment']) {
      expect(c({ caption }).risk).toBe('REVIEW_REQUIRED');
    }
  });
  it('actions beyond the settings need review', () => {
    expect(codes({ scheduledAt: new Date('2026-11-16T03:00:00Z') })).toContain('OUTSIDE_HOURS');
    expect(codes({ postsThatDay: 3 })).toContain('DAILY_LIMIT');
    expect(c({ platformConfirmationMissing: true }).risk).toBe('REVIEW_REQUIRED');
  });
  it('BLOCKED cannot be lifted by any mode', () => {
    for (const mode of ['AUTO', 'HYBRID', 'MANUAL'] as const) {
      expect(c({ mode, contentKind: 'TEXT', caption: '', allowedContentTypes: ['TEXT'] }).risk).toBe('BLOCKED');
      expect(c({ mode, caption: 'token sk-abcdefghijklmnopqrstuvwxyz123456' }).risk).toBe('BLOCKED');
      expect(c({ mode, groundingIssues: 1 }).risk).toBe('BLOCKED');
      expect(c({ mode, contentKind: 'VIDEO', platform: 'INSTAGRAM', allowedContentTypes: ['IMAGE'] }).risk).toBe('BLOCKED');
    }
    expect(c({ platform: 'TIKTOK', contentKind: 'IMAGE' }).risk).toBe('BLOCKED');
  });
});

describe('hours and policy validation', () => {
  it('reads the time in the policy timezone', () => {
    const w = [{ days: [1], from: '09:00', to: '12:00' }];
    expect(withinHours(new Date('2026-11-16T08:30:00Z'), 'Africa/Ndjamena', w)).toBe(true); // Monday 09:30 local (UTC+1)
    expect(withinHours(new Date('2026-11-16T08:30:00Z'), 'UTC', w)).toBe(false);
    expect(withinHours(new Date('2026-11-17T08:30:00Z'), 'Africa/Ndjamena', w)).toBe(false);
  });
  it('validates', () => {
    expect(validateHours([{ days: [1], from: '09:00', to: '08:00' }])).toBe(false);
    expect(validateHours([])).toBe(false);
    expect(validatePolicyDraft({ mode: 'AUTO', maximumPostsPerDay: 50, timezone: 'Nowhere/Land', allowedContentTypes: [], allowedPublishingHours: [] })).toEqual(['maximumPostsPerDay', 'allowedContentTypes', 'allowedPublishingHours', 'timezone']);
  });
  it('TikTok needs a confirmation per post; nothing is claimed for unknown platforms', () => {
    expect(platformFacts('TIKTOK')?.perPostConfirmation).toBe(true);
    expect(platformFacts('SNAPCHAT')).toBeNull();
  });
});
