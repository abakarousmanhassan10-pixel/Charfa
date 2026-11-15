import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { as, type Ctx } from './ai-helpers';
import { prisma, resetDb, startApp } from './helpers';
import { socialHelpers } from './social-helpers';
import { seedHistory } from '../src/learning/demo-history';
import { PrismaService } from '../src/prisma/prisma.service';

/** N22 phase B: client preference memory and adaptive recommendations (simulated metrics; nothing is published). */
const ENV: Record<string, string> = { LEARNING_ENABLED: 'true', ANALYTICS_PROVIDER: 'mock', LEARNING_RATE_LIMIT_PER_MINUTE: '1000' };
const CONSENT = { accept: true, consentVersion: '2026-12-v1' };

describe('Learning: preferences and recommendations (simulated)', () => {
  const saved: Record<string, string | undefined> = {};
  let app: INestApplication;
  let h: ReturnType<typeof socialHelpers>;
  let n = 0;
  const api = (m: 'get' | 'post' | 'put' | 'delete', path: string, c: Ctx, body?: object) => { const r = request(h.http)[m](`/api/v1/learning/${path}`).set(as(c)); return body !== undefined ? r.send(body) : m === 'post' ? r.send({}) : r; };

  beforeAll(async () => {
    for (const [k, v] of Object.entries(ENV)) { saved[k] = process.env[k]; process.env[k] = v; }
    await resetDb();
    app = await startApp();
    h = socialHelpers(app);
  });
  afterAll(async () => { await app.close(); await prisma.$disconnect(); for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });

  /** A business with an owner, an editor and a viewer, an Instagram account and 30 fictitious published posts already measured. */
  async function biz(posts = 30) {
    const owner = await h.tenant(`Prefs ${++n}`);
    const editor = await h.member(owner, 'EDITOR');
    const viewer = await h.member(owner, 'VIEWER');
    const account = await h.connect(owner, 'INSTAGRAM');
    if (posts) {
      await seedHistory(app.get(PrismaService), { businessId: owner.businessId, socialAccountId: account.id, platform: 'INSTAGRAM', count: posts });
      await api('post', 'performance/collect', owner).expect(200);
    }
    return { owner, editor, viewer, account };
  }
  type Biz = Awaited<ReturnType<typeof biz>>;
  const consent = (b: Biz) => api('post', 'consent', b.owner, CONSENT).expect(200);
  const generate = (b: Biz) => api('post', 'recommendations/generate', b.owner);

  it('three separate layers; a declared value beats an inferred one; a correction replaces it and keeps the history', async () => {
    const b = await biz();
    await consent(b);
    await api('put', 'preferences/tone', b.owner, { value: 'playful' }).expect(200);
    await api('put', 'preferences/tone', b.owner, { value: 'formal', reason: 'Our customers prefer a formal tone' }).expect(200);
    await api('put', 'preferences/content.preferredTypes', b.owner, { value: ['IMAGE'] }).expect(200);
    await generate(b).expect(200);
    const p = (await api('get', 'preferences', b.owner).expect(200)).body;
    expect(p.declared.map((x: { key: string }) => x.key).sort()).toEqual(['content.preferredTypes', 'tone']);
    expect(p.inferred.length).toBeGreaterThan(0);
    expect(p.inferred.every((x: { key: string }) => x.key.startsWith('inferred.'))).toBe(true);
    expect(p.effective.tone).toEqual({ origin: 'DECLARED', value: 'formal' });
    const hist = (await api('get', 'preferences/revisions?key=tone', b.owner).expect(200)).body;
    expect(hist.map((r: { action: string; value: string }) => `${r.action}:${r.value}`).reverse()).toEqual(['SET:playful', 'CORRECT:formal']);
    // The client cannot write the system's keys, nor personal data or invalid values.
    await api('put', 'preferences/inferred.bestSlot', b.owner, { value: { bucket: 'evening' } }).expect(409);
    await api('put', 'preferences/audience', b.owner, { value: 'reach me at boss@example.com' }).expect(409);
    await api('put', 'preferences/tone', b.owner, { value: 'rude' }).expect(409);
    await api('put', 'preferences/tone', b.editor, { value: 'friendly' }).expect(403);
  });

  it('a declared restriction beats what the system inferred: the contradicting observation stops counting and is not proposed again', async () => {
    const b = await biz();
    await consent(b);
    await generate(b).expect(200);
    // An observation the system made earlier (VIDEO does best), then the client declares it only wants IMAGE posts.
    await prisma.clientPreference.upsert({ where: { businessId_key_origin: { businessId: b.owner.businessId, key: 'inferred.bestKind', origin: 'INFERRED' } }, create: { businessId: b.owner.businessId, key: 'inferred.bestKind', origin: 'INFERRED', value: { kind: 'VIDEO' }, confidence: 'LOW' }, update: { value: { kind: 'VIDEO' }, status: 'ACTIVE' } });
    expect((await api('get', 'preferences', b.owner).expect(200)).body.effective['inferred.bestKind']).toMatchObject({ value: { kind: 'VIDEO' } });
    await api('put', 'preferences/content.preferredTypes', b.owner, { value: ['IMAGE'] }).expect(200);
    const after = (await api('get', 'preferences', b.owner).expect(200)).body;
    expect(after.inferred.find((x: { key: string }) => x.key === 'inferred.bestKind').status).toBe('SUPERSEDED');
    expect(after.effective['inferred.bestKind']).toBeUndefined();
    expect((await api('get', 'preferences/revisions?key=inferred.bestKind', b.owner).expect(200)).body[0].action).toBe('SUPERSEDE');
    // The next analysis never proposes the disallowed format, and does not bring the observation back.
    await generate(b).expect(200);
    const recs = (await api('get', 'recommendations', b.owner).expect(200)).body;
    // The proposal made before the client declared IMAGE only is withdrawn, and the format is not proposed again.
    expect(recs.filter((x: { proposedAction: { kind?: string }; status: string }) => x.proposedAction.kind === 'VIDEO' && x.status === 'PROPOSED')).toEqual([]);
    expect(recs.find((x: { proposedAction: { kind?: string } }) => x.proposedAction.kind === 'VIDEO')?.status).toBe('DISMISSED');
    expect((await api('get', 'preferences', b.owner).expect(200)).body.effective['inferred.bestKind']).toBeUndefined();
  });

  it('recommendations carry justification, data used, confidence, limits and effects to verify; simulated data never gets more than LOW; no promises', async () => {
    const b = await biz();
    await consent(b);
    const sum = (await generate(b).expect(200)).body;
    expect(sum.analyzed.INSTAGRAM).toMatchObject({ usable: 30, origin: 'SIMULATED' });
    expect(sum.created).toBeGreaterThan(0);
    const recs = (await api('get', 'recommendations', b.owner).expect(200)).body;
    for (const r of recs) {
      expect(r).toMatchObject({ source: 'LEARNING', status: 'PROPOSED', confidence: 'LOW', requiredApproval: 'MERCHANT' });
      expect(r.evidence.justification).toBeTruthy();
      expect(r.evidence.dataUsed).toMatchObject({ metric: 'engagementRate', origin: 'SIMULATED' });
      expect(r.evidence.limitations.join(' ')).toMatch(/simulator/);
      expect(r.evidence.expectedEffects.every((e: { toVerify: boolean }) => e.toVerify === true)).toBe(true);
      expect(r.expectedBenefit.type).toBe('NOT_ESTIMATED');
      expect(JSON.stringify(r)).not.toMatch(/guarantee|will increase|because of this|revenue/i);
    }
    // Running again refreshes open proposals instead of duplicating them.
    const sum2 = (await generate(b).expect(200)).body;
    expect(sum2.created).toBe(0);
    expect((await api('get', 'recommendations', b.owner).expect(200)).body).toHaveLength(recs.length);
  });

  it('too little data: no recommendation is produced, and the reason is given', async () => {
    const b = await biz(6);
    await consent(b);
    const sum = (await generate(b).expect(200)).body;
    expect(sum.created).toBe(0);
    expect(sum.analyzed.INSTAGRAM.insufficient[0]).toMatch(/at least 12/);
    expect((await api('get', 'recommendations', b.owner).expect(200)).body).toEqual([]);
  });

  it('a rejected recommendation is remembered and never proposed again; the decision is recorded with feedback', async () => {
    const b = await biz();
    await consent(b);
    await generate(b).expect(200);
    const [first] = (await api('get', 'recommendations', b.owner).expect(200)).body;
    await api('post', `recommendations/${first.id}/decision`, b.owner, { decision: 'REJECT', reason: 'Not for us' }).expect(200);
    await api('post', `recommendations/${first.id}/decision`, b.owner, { decision: 'ACCEPT' }).expect(409);
    await generate(b).expect(200);
    const all = (await api('get', 'recommendations', b.owner).expect(200)).body;
    expect(all.filter((r: { evidence: { key: string } }) => r.evidence.key === first.evidence.key)).toHaveLength(1);
    expect(all.find((r: { id: string }) => r.id === first.id).status).toBe('REJECTED');
    expect(await prisma.recommendationFeedback.count({ where: { recommendationId: first.id, decision: 'REJECTED' } })).toBe(1);
    // Accepting another adopts its observation but changes nothing about publishing.
    const second = all.find((r: { status: string; kind: string }) => r.status === 'PROPOSED' && r.kind !== 'TITLE_VARIANT');
    if (second) {
      await api('post', `recommendations/${second.id}/decision`, b.owner, { decision: 'ACCEPT' }).expect(200);
      expect(await prisma.publication.count({ where: { businessId: b.owner.businessId, simulated: false } })).toBe(0);
      expect(await prisma.calendarEvent.count({ where: { businessId: b.owner.businessId } })).toBe(0);
    }
    await api('post', `recommendations/${all[all.length - 1].id}/feedback`, b.owner, { decision: 'NOT_USEFUL' }).expect(200);
  });

  it('hypotheses are never used until confirmed; a rejected one is never inferred again', async () => {
    const b = await biz();
    await consent(b);
    await prisma.clientPreference.create({ data: { businessId: b.owner.businessId, key: 'hypothesis.hook.question', origin: 'HYPOTHESIS', value: { dimension: 'hook', label: 'question' }, evidence: { statement: 'x' }, confidence: 'LOW' } });
    await prisma.clientPreference.create({ data: { businessId: b.owner.businessId, key: 'hypothesis.topic.#jus', origin: 'HYPOTHESIS', value: { dimension: 'topic', label: '#jus' }, evidence: { statement: 'y' }, confidence: 'LOW' } });
    let p = (await api('get', 'preferences', b.owner).expect(200)).body;
    expect(p.hypotheses).toHaveLength(2);
    expect(Object.keys(p.effective).some((k) => k.startsWith('hypothesis'))).toBe(false);
    await api('post', 'preferences/hypothesis.hook.question/confirm', b.owner).expect(200);
    await api('post', 'preferences/hypothesis.topic.%23jus/reject', b.owner, { origin: 'HYPOTHESIS' }).expect(200);
    p = (await api('get', 'preferences', b.owner).expect(200)).body;
    expect(p.effective['inferred.hook']).toMatchObject({ origin: 'INFERRED', value: { hook: 'question' } });
    expect(p.hypotheses.find((x: { key: string }) => x.key === 'hypothesis.topic.#jus').status).toBe('REJECTED');
  });

  it('export, deletion of one key and of everything (with history); other clients are untouched', async () => {
    const a = await biz();
    const other = await biz();
    await consent(a); await consent(other);
    await api('put', 'preferences/tone', a.owner, { value: 'friendly' }).expect(200);
    await api('put', 'preferences/sector', a.owner, { value: 'Beverages' }).expect(200);
    await api('put', 'preferences/tone', other.owner, { value: 'formal' }).expect(200);
    const exp = (await api('get', 'preferences/export', a.owner).expect(200)).body;
    expect(exp.businessId).toBe(a.owner.businessId);
    expect(exp.preferences.map((p: { key: string }) => p.key).sort()).toEqual(['sector', 'tone']);
    expect(exp.revisions).toHaveLength(2);
    expect(JSON.stringify(exp)).not.toContain('formal'); // nothing of another client
    expect((await api('delete', 'preferences/tone', a.owner).expect(200)).body).toMatchObject({ erased: 1, revisions: 1 });
    expect((await api('get', 'preferences', a.owner).expect(200)).body.declared.map((x: { key: string }) => x.key)).toEqual(['sector']);
    await api('delete', 'preferences', a.owner).expect(200);
    expect((await api('get', 'preferences/export', a.owner).expect(200)).body).toMatchObject({ preferences: [], revisions: [] });
    expect((await api('get', 'preferences', other.owner).expect(200)).body.effective.tone.value).toBe('formal');
    await api('delete', 'preferences', a.editor).expect(403);
    await api('get', 'preferences', a.viewer).expect(200);
  });

  it('withdrawing the consent stops the analysis and erases what the system inferred, keeping what the client declared', async () => {
    const b = await biz();
    await generate(b).expect(409).expect((r) => expect(r.body.code).toBe('CONSENT_REQUIRED'));
    await consent(b);
    await api('put', 'preferences/tone', b.owner, { value: 'friendly' }).expect(200);
    await generate(b).expect(200);
    expect((await api('get', 'preferences', b.owner).expect(200)).body.inferred.length).toBeGreaterThan(0);
    const res = (await api('post', 'consent/revoke', b.owner).expect(200)).body;
    expect(res).toMatchObject({ consentValid: false, enabled: false });
    const p = (await api('get', 'preferences', b.owner).expect(200)).body;
    expect(p.inferred).toEqual([]); expect(p.hypotheses).toEqual([]);
    expect(p.declared).toHaveLength(1);
    await generate(b).expect(409);
    await api('post', 'consent', b.owner, { accept: true, consentVersion: 'old' }).expect(409);
  });

  it('variants differ in one element and honour the client restrictions; tenants are isolated', async () => {
    const a = await biz(0);
    const other = await biz(0);
    await api('put', 'preferences/editorial.restrictions', a.owner, { value: ['promo'] }).expect(200);
    const v = (await api('post', 'variants', a.owner, { title: 'Fresh bissap today', caption: 'Brewed every morning.', hashtags: ['#bissap'] }).expect(200)).body;
    expect(v.changed).toEqual(['title.hook']);
    expect(v.b.title).toMatch(/\?$/);
    await api('post', 'variants', a.owner, { title: 'Big promo today', caption: 'x' }).expect(400);
    expect((await api('get', 'preferences', other.owner).expect(200)).body.declared).toEqual([]);
    expect((await api('get', 'recommendations', other.owner).expect(200)).body).toEqual([]);
  });
});
