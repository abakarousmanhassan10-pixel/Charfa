import { PLATFORM_FEATURES, featureStates } from './social-capabilities';

describe('featureStates', () => {
  const all = ['commentsRead', 'commentsReply'] as const;
  it('reports missing permissions, never availability, until they are granted', () => {
    const r = featureStates('INSTAGRAM', ['instagram_basic', 'instagram_content_publish'], all);
    expect(r.commentsRead).toMatchObject({ state: 'PERMISSION_MISSING', missingScopes: ['instagram_manage_comments', 'pages_read_engagement'] });
    const ok = featureStates('INSTAGRAM', ['instagram_manage_comments', 'pages_read_engagement'], all);
    expect(ok.commentsReply.state).toBe('AVAILABLE');
  });
  it('marks sources that disagree as unverified even when the permission is held', () => {
    expect(featureStates('FACEBOOK', ['pages_read_engagement', 'pages_manage_engagement'], all)).toMatchObject({ commentsRead: { state: 'UNVERIFIED' }, commentsReply: { state: 'UNVERIFIED' } });
    expect(featureStates('YOUTUBE', ['https://www.googleapis.com/auth/youtube.readonly'], all)).toMatchObject({ commentsRead: { state: 'UNVERIFIED' }, commentsReply: { state: 'PERMISSION_MISSING', missingScopes: ['https://www.googleapis.com/auth/youtube.force-ssl'] } });
  });
  it('never offers what the platform does not support or TOUMA does not implement', () => {
    const t = featureStates('TIKTOK', ['everything'], all);
    expect(t.commentsRead.state).toBe('UNSUPPORTED');
    expect(t.directMessages.state).toBe('UNSUPPORTED');
    expect(featureStates('FACEBOOK', ['pages_messaging'], all).directMessages.state).toBe('NOT_IMPLEMENTED');
    expect(featureStates('FACEBOOK', ['pages_read_engagement'], []).commentsRead.state).toBe('NOT_IMPLEMENTED'); // adapter lacks the method
  });
  it('has a statement for every platform', () => {
    for (const p of Object.keys(PLATFORM_FEATURES)) expect(PLATFORM_FEATURES[p as keyof typeof PLATFORM_FEATURES].appReview.length).toBeGreaterThan(10);
  });
});
