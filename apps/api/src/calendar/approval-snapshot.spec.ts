import { snapshotHash, type SnapshotInput } from './approval-snapshot';

const base: SnapshotInput = { contentId: 'c1', version: 3, type: 'IMAGE', title: 'T', caption: 'Hello', hashtags: ['a', 'b'], callToAction: null, platformOptions: null, mediaIds: ['m1', 'm2'], platform: 'INSTAGRAM', socialAccountId: 'acc1', scheduledAt: new Date('2027-01-01T10:00:00Z'), timezone: 'Africa/Ndjamena' };

describe('snapshotHash', () => {
  it('is stable and independent of object key order', () => {
    expect(snapshotHash(base)).toBe(snapshotHash({ ...base }));
    expect(snapshotHash({ ...base, platformOptions: { tiktok: { b: 1, a: 2 } } })).toBe(snapshotHash({ ...base, platformOptions: { tiktok: { a: 2, b: 1 } } }));
    expect(snapshotHash(base)).toMatch(/^[0-9a-f]{64}$/);
  });
  it('changes with every material field', () => {
    const h = snapshotHash(base);
    const changes: Array<Partial<SnapshotInput>> = [
      { caption: 'Hello!' }, { title: 'U' }, { hashtags: ['a'] }, { callToAction: 'Buy' }, { mediaIds: ['m2', 'm1'] }, { mediaIds: ['m1'] }, { version: 4 },
      { socialAccountId: 'acc2' }, { socialAccountId: null }, { platform: 'FACEBOOK' }, { scheduledAt: new Date('2027-01-01T10:00:01Z') }, { timezone: 'UTC' }, { contentId: 'c2' }, { type: 'TEXT' },
      { platformOptions: { tiktok: { privacyLevel: 'PUBLIC' } } },
    ];
    for (const c of changes) expect(snapshotHash({ ...base, ...c })).not.toBe(h);
  });
  it('ignores who confirmed the TikTok settings and when', () => {
    const a = snapshotHash({ ...base, platformOptions: { tiktok: { privacyLevel: 'PUBLIC', confirmedAt: '2027-01-01', confirmedById: 'u1' } } });
    const b = snapshotHash({ ...base, platformOptions: { tiktok: { privacyLevel: 'PUBLIC', confirmedAt: '2028-02-02', confirmedById: 'u2' } } });
    expect(a).toBe(b);
  });
});
