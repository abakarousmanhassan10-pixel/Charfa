/**
 * Client preferences (N22). Three origins, never mixed: DECLARED (the client said it), INFERRED (the system observed it), HYPOTHESIS (to confirm).
 * Only the client writes DECLARED values; only the learning run writes INFERRED and HYPOTHESIS. A declared value always wins.
 */
export const PREFERENCE_ORIGINS = ['DECLARED', 'INFERRED', 'HYPOTHESIS'] as const;
export type PreferenceOriginName = (typeof PREFERENCE_ORIGINS)[number];

export const TONES = ['friendly', 'professional', 'playful', 'formal', 'inspiring'] as const;
export const GOALS = ['awareness', 'engagement', 'traffic', 'leads', 'sales'] as const;
const KINDS = ['TEXT', 'IMAGE', 'CAROUSEL', 'VIDEO'];
const LANGS = ['en', 'fr', 'tr', 'ar'];

const PERSONAL = /[\w.+-]+@[\w-]+\.[\w.-]{2,}|(?<![\d.])\+?\d[\d\s().-]{8,}\d(?![\d.])/;
const SECRET = /(sk-[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{12,}|-----BEGIN [A-Z ]*PRIVATE KEY|Bearer\s+[A-Za-z0-9._-]{20,})/;
const text = (max: number) => (v: unknown): string | null => (typeof v === 'string' && v.trim().length > 0 && v.trim().length <= max && !PERSONAL.test(v) && !SECRET.test(v) ? v.trim() : null);
const list = (max: number, item: (v: unknown) => string | null) => (v: unknown): string[] | null => {
  if (!Array.isArray(v) || v.length > max) return null;
  const out = v.map(item);
  return out.every((x): x is string => x !== null) ? (out as string[]) : null;
};

/** Keys a client may declare, with the check applied to their value. */
export const DECLARABLE: Record<string, (v: unknown) => unknown | null> = {
  'brand.identity': text(400),
  language: (v) => (typeof v === 'string' && LANGS.includes(v) ? v : null),
  tone: (v) => (typeof v === 'string' && (TONES as readonly string[]).includes(v) ? v : null),
  sector: text(120),
  audience: text(300),
  'content.preferredTypes': (v) => { const l = list(4, (x) => (typeof x === 'string' && KINDS.includes(x) ? x : null))(v); return l && l.length ? [...new Set(l)] : null; },
  'editorial.restrictions': list(30, text(120)),
  'marketing.goals': (v) => { const l = list(5, (x) => (typeof x === 'string' && (GOALS as readonly string[]).includes(x) ? x : null))(v); return l && l.length ? [...new Set(l)] : null; },
  'publishing.preferredHour': (v) => (Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 23 ? v : null),
  'corrections.validated': list(50, text(300)),
};

/** What the system itself may write (observations and things to confirm). A client cannot write these keys as declared values. */
export const INFERABLE = ['inferred.bestSlot', 'inferred.bestKind', 'inferred.captionLength', 'inferred.hook', 'inferred.topic', 'inferred.frequency'] as const;
export const isInferable = (k: string) => (INFERABLE as readonly string[]).includes(k) || k.startsWith('hypothesis.');

export function validateDeclared(key: string, value: unknown): { ok: true; value: unknown } | { ok: false; error: string } {
  const check = DECLARABLE[key];
  if (!check) return { ok: false, error: `Unknown preference "${key}"` };
  const v = check(value);
  return v === null || v === undefined ? { ok: false, error: `Invalid value for "${key}" (no personal data, secrets or out-of-range values)` } : { ok: true, value: v };
}

/** Declared > inferred > hypothesis. A rejected or superseded row never counts; a hypothesis is shown but never used until confirmed. */
export interface PrefRow { key: string; origin: PreferenceOriginName; value: unknown; status: string; evidence?: unknown }
export function effectivePreferences(rows: PrefRow[]): Record<string, { origin: PreferenceOriginName; value: unknown }> {
  const out: Record<string, { origin: PreferenceOriginName; value: unknown }> = {};
  for (const origin of ['INFERRED', 'DECLARED'] as const) for (const r of rows) if (r.origin === origin && r.status === 'ACTIVE') out[r.key] = { origin, value: r.value };
  return out;
}
