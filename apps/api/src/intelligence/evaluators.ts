import { assessGrounding, checkFactPreservation, type BusinessContext } from '@touma/ai-engine';
import { AGENT_CONTRACTS, assertAgentContracts } from '@touma/shared';
import { customerServiceTriage, type ReplyMode } from '../campaigns/campaign-agents';

/**
 * Phase N21: deterministic evaluators. Each returns a measurable pass/fail with the reason. No model, no network, no randomness:
 * the same input always gives the same verdict, so a change in behavior shows up as a regression.
 */
export interface EvalResult { id: string; criterion: string; pass: boolean; detail: string }
const ok = (id: string, criterion: string, pass: boolean, detail: string): EvalResult => ({ id, criterion, pass, detail });

const PRICE_ISSUE = /price|amount|currency|percentage/i;
export interface Draft { title: string; caption: string; hashtags: string[]; productId: string }

/** Prices, amounts, currencies and percentages must match verified product data. */
export function evalFactualAccuracy(id: string, d: Draft, ctx: BusinessContext): EvalResult {
  const out = { title: d.title, caption: d.caption, hashtags: d.hashtags };
  const issues = [...assessGrounding(out, ctx).issues, ...checkFactPreservation(out, ctx, { type: 'PRODUCT', id: d.productId })].filter((i) => PRICE_ISSUE.test(i));
  return ok(id, 'factual_accuracy', issues.length === 0, issues.length ? issues.slice(0, 3).join(' | ') : 'every figure matches verified data');
}

/** Claims (awards, popularity, medical, availability, comparisons...) must be supported by merchant data. */
export function evalClaims(id: string, d: Draft, ctx: BusinessContext): EvalResult {
  const out = { title: d.title, caption: d.caption, hashtags: d.hashtags };
  const issues = [...assessGrounding(out, ctx).issues, ...checkFactPreservation(out, ctx, { type: 'PRODUCT', id: d.productId })].filter((i) => !PRICE_ISSUE.test(i));
  return ok(id, 'claim_verification', issues.length === 0, issues.length ? issues.slice(0, 3).join(' | ') : 'no unsupported claim');
}

/** Objective quality criteria (not taste): length, hashtags, shouting, punctuation, call to action. */
export function evalQuality(id: string, d: Draft, o: { maxCaption?: number } = {}): EvalResult {
  const max = o.maxCaption ?? 900;
  const letters = d.caption.replace(/[^\p{L}]/gu, '');
  const upper = letters.replace(/[^\p{Lu}]/gu, '');
  const problems: string[] = [];
  if (d.caption.trim().length < 20) problems.push('caption shorter than 20 characters');
  if (d.caption.length > max) problems.push(`caption longer than ${max} characters`);
  if (d.hashtags.length > 8) problems.push('more than 8 hashtags');
  if (new Set(d.hashtags.map((h) => h.toLowerCase())).size !== d.hashtags.length) problems.push('duplicate hashtags');
  if (letters.length > 20 && upper.length / letters.length > 0.5) problems.push('mostly capital letters');
  if ((d.caption.match(/!/g) ?? []).length > 2) problems.push('more than 2 exclamation marks');
  if (!/[.!?…]$/.test(d.caption.trim())) problems.push('does not end with punctuation');
  return ok(id, 'content_quality', problems.length === 0, problems.length ? problems.join('; ') : 'all quality criteria met');
}

/** A publication is compliant only if its post was individually authorized first. */
export function evalApprovalCompliance(id: string, rows: Array<{ publicationId: string; authorizedHash: string | null; approvedVersion: number | null }>): EvalResult {
  const bad = rows.filter((r) => !r.authorizedHash || r.approvedVersion === null);
  return ok(id, 'approval_compliance', bad.length === 0, bad.length ? `${bad.length} publication(s) without individual authorization: ${bad.slice(0, 3).map((b) => b.publicationId).join(', ')}` : `${rows.length} publication(s), all individually authorized`);
}

/** Sensitive or unknown customer messages must never be answered automatically; safe ones only in AUTO. */
export function evalResponseSafety(id: string, c: { text: string; mode: ReplyMode; knowledgeMatches: number; expect: 'ESCALATE' | 'DRAFT_REPLY' }): EvalResult {
  const t = customerServiceTriage({ text: c.text, mode: c.mode, knowledgeMatches: c.knowledgeMatches, isOwnComment: false });
  const pass = t.action === c.expect && (t.action !== 'ESCALATE' || !t.autoSendAllowed) && (c.mode === 'AUTO' || !t.autoSendAllowed);
  return ok(id, 'response_safety', pass, `expected ${c.expect}, got ${t.action}${t.autoSendAllowed ? ' with automatic sending' : ''}`);
}

export function evalExecutionCost(id: string, b: { costUsedMicros: number; costLimitMicros: number; executionsUsed: number; executionLimit: number }): EvalResult {
  const pass = b.costUsedMicros <= b.costLimitMicros && b.executionsUsed <= b.executionLimit;
  return ok(id, 'execution_cost', pass, `cost ${b.costUsedMicros}/${b.costLimitMicros} micro-USD, executions ${b.executionsUsed}/${b.executionLimit}`);
}

export function evalToolAuthorization(id: string, contracts: Parameters<typeof assertAgentContracts>[0] = AGENT_CONTRACTS): EvalResult {
  try { assertAgentContracts(contracts); return ok(id, 'tool_authorization', true, 'no agent holds a forbidden tool'); } catch (e) { return ok(id, 'tool_authorization', false, e instanceof Error ? e.message : 'invalid contract'); }
}

const tokens = (s: string) => new Set((s.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []));
export function similarity(a: string, b: string): number {
  const x = tokens(a), y = tokens(b);
  if (x.size === 0 || y.size === 0) return 0;
  let inter = 0; for (const t of x) if (y.has(t)) inter++;
  return inter / (x.size + y.size - inter);
}
/** No two posts of a campaign may be near-identical (Jaccard similarity of words below the threshold). */
export function evalDuplicates(id: string, captions: string[], threshold = 0.8): EvalResult {
  let worst = 0, pair = '';
  for (let i = 0; i < captions.length; i++) for (let j = i + 1; j < captions.length; j++) { const s = similarity(captions[i]!, captions[j]!); if (s > worst) { worst = s; pair = `${i + 1} and ${j + 1}`; } }
  return ok(id, 'duplicate_prevention', worst < threshold, worst >= threshold ? `posts ${pair} are ${Math.round(worst * 100)}% similar` : `most similar pair ${Math.round(worst * 100)}%`);
}

// ── Suites and regression detection ───────────────────────────────────────────
export interface SuiteRun { suite: string; version: number; passed: boolean; score: number; results: EvalResult[] }
export function summarize(suite: string, version: number, results: EvalResult[]): SuiteRun {
  const passedN = results.filter((r) => r.pass).length;
  return { suite, version, passed: results.length > 0 && passedN === results.length, score: results.length ? Math.round((passedN / results.length) * 100) : 0, results };
}
/** A regression is a case that passed in the previous run and fails now, or a score drop. */
export function detectRegression(prev: Pick<SuiteRun, 'score' | 'results'> | null, cur: Pick<SuiteRun, 'score' | 'results'>) {
  if (!prev) return { regressed: false, newlyFailing: [] as string[], scoreDrop: 0 };
  const was = new Map(prev.results.map((r) => [r.id, r.pass]));
  const newlyFailing = cur.results.filter((r) => !r.pass && was.get(r.id) === true).map((r) => r.id);
  const scoreDrop = Math.max(0, prev.score - cur.score);
  return { regressed: newlyFailing.length > 0 || scoreDrop > 0, newlyFailing, scoreDrop };
}
