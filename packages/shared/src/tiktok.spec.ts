import { checkTikTokSettings, tiktokLabel } from './tiktok';

const base = { privacyLevel: 'PUBLIC_TO_EVERYONE', allowComment: false, allowDuet: false, allowStitch: false, commercial: { enabled: false, yourBrand: false, brandedContent: false }, consent: true };
const errs = (input: unknown, kind: 'VIDEO' | 'IMAGE' | 'CAROUSEL' = 'VIDEO') => { const r = checkTikTokSettings(input, kind); return 'errors' in r ? r.errors.map((e) => e.code) : []; };

describe('TikTok posting settings (Content Sharing Guidelines)', () => {
  it('accepts complete settings and normalizes missing switches to OFF', () => {
    const r = checkTikTokSettings({ privacyLevel: 'SELF_ONLY', consent: true }, 'VIDEO');
    expect(r).toEqual({ ok: true, value: { privacyLevel: 'SELF_ONLY', allowComment: false, allowDuet: false, allowStitch: false, commercial: { enabled: false, yourBrand: false, brandedContent: false }, consent: true } });
  });
  it('has no default privacy and needs consent', () => {
    expect(errs({})).toEqual(expect.arrayContaining(['PRIVACY_REQUIRED', 'CONSENT_REQUIRED']));
    expect(errs({ ...base, privacyLevel: 'EVERYONE' })).toContain('PRIVACY_REQUIRED');
    expect(errs({ ...base, consent: false })).toEqual(['CONSENT_REQUIRED']);
    expect(errs(null)).toContain('PRIVACY_REQUIRED');
  });
  it('commercial disclosure needs a type, cannot be inconsistent, and branded content cannot be private', () => {
    expect(errs({ ...base, commercial: { enabled: true, yourBrand: false, brandedContent: false } })).toEqual(['DISCLOSURE_INCOMPLETE']);
    expect(errs({ ...base, commercial: { enabled: false, yourBrand: true, brandedContent: false } })).toEqual(['DISCLOSURE_INCONSISTENT']);
    expect(errs({ ...base, privacyLevel: 'SELF_ONLY', commercial: { enabled: true, yourBrand: false, brandedContent: true } })).toEqual(['BRANDED_NOT_PRIVATE']);
    expect(errs({ ...base, privacyLevel: 'SELF_ONLY', commercial: { enabled: true, yourBrand: true, brandedContent: false } })).toEqual([]);
  });
  it('duet and stitch exist for videos only', () => {
    expect(errs({ ...base, allowDuet: true }, 'IMAGE')).toEqual(['VIDEO_ONLY_CONTROL']);
    expect(errs({ ...base, allowStitch: true }, 'CAROUSEL')).toEqual(['VIDEO_ONLY_CONTROL']);
    expect(errs({ ...base, allowDuet: true, allowStitch: true }, 'VIDEO')).toEqual([]);
  });
  it('shows the label TikTok applies', () => {
    expect(tiktokLabel({ commercial: { enabled: false, yourBrand: true, brandedContent: true } })).toBe('NONE');
    expect(tiktokLabel({ commercial: { enabled: true, yourBrand: true, brandedContent: false } })).toBe('PROMOTIONAL');
    expect(tiktokLabel({ commercial: { enabled: true, yourBrand: true, brandedContent: true } })).toBe('PAID_PARTNERSHIP');
  });
});
