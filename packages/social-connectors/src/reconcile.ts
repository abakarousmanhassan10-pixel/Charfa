import { SocialApiError, type ReconcileOutcome, type ReconcileQuery } from './types';

export interface Candidate {
  id: string;
  text: string;
  /** ISO time the platform says the post was created. */
  at?: string | null;
  url?: string | null;
}

const norm = (t: string) => t.replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * Decides which listed posts are ours: created after the create request started, with the same text.
 * One match = FOUND. Several = AMBIGUOUS (a person decides). None = NOT_FOUND (not proof: the listing may lag).
 */
export function matchCandidates(list: Candidate[], q: ReconcileQuery, checked = list.length): ReconcileOutcome {
  const wanted = norm(q.text);
  const earliest = q.since.getTime() - 120_000;
  const hits = list.filter((c) => {
    if (c.at) {
      const t = Date.parse(c.at);
      if (Number.isFinite(t) && t < earliest) return false;
    }
    const text = norm(c.text);
    return wanted ? text === wanted : q.title ? text === norm(q.title) : false;
  });
  if (hits.length === 1) return { result: 'FOUND', externalPostId: hits[0]!.id, url: hits[0]!.url ?? null };
  if (hits.length > 1) return { result: 'AMBIGUOUS', candidates: hits.map((h) => ({ id: h.id, url: h.url ?? null })) };
  return { result: 'NOT_FOUND', checked };
}

/** A failed lookup is never a "not found": it means the platform could not be asked. */
export function unavailable(e: unknown): ReconcileOutcome {
  if (e instanceof SocialApiError) return { result: 'UNAVAILABLE', reason: e.kind === 'permission' || e.kind === 'auth' ? `The granted permissions do not allow listing posts (${e.kind}): ${e.message}`.slice(0, 300) : `The platform could not be asked (${e.kind}): ${e.message}`.slice(0, 300) };
  return { result: 'UNAVAILABLE', reason: 'The platform could not be asked.' };
}
