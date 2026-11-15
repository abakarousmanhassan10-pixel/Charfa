import { validateHours, type HoursWindow } from './publishing-policy';

/**
 * No-code agent builder (N23), first slice: the definition of a custom agent and its validation. Pure and server-authoritative: the browser form is a convenience,
 * every rule here is checked again by the API. A DRAFT may be saved with issues; testing and (later) activation need zero errors.
 */
export const AGENT_CATEGORIES = ['MARKETING', 'SOCIAL', 'SUPPORT', 'ECOMMERCE', 'RESEARCH', 'ANALYTICS', 'ASSISTANT', 'CUSTOM'] as const;
export type AgentCategory = (typeof AGENT_CATEGORIES)[number];
export const BUILDER_TONES = ['friendly', 'professional', 'playful', 'formal', 'inspiring'] as const;
export const BUILDER_LANGUAGES = ['en', 'fr', 'tr', 'ar'] as const;
export const BUILDER_PROVIDERS = ['mock', 'openai'] as const;
/** The simulator model is always allowed; real model names come from server configuration only (never invented here). */
export const MOCK_MODEL = 'mock-model';

export type ToolKind = 'INTERNAL_READ' | 'INTERNAL_WRITE' | 'EXTERNAL';
export interface ToolSpec { id: string; label: string; kind: ToolKind; /** false = cannot be granted until an authorized connection exists. */ enabled: boolean; requiresConfirmation: boolean; risk: 'LOW' | 'MEDIUM' | 'HIGH'; note: string }
/** The minimal tool registry of this slice. External tools exist only as disabled entries: nothing is connected, nothing can be called. */
export const BUILDER_TOOLS: readonly ToolSpec[] = [
  { id: 'knowledge.lookup', label: 'Look up verified business knowledge', kind: 'INTERNAL_READ', enabled: true, requiresConfirmation: false, risk: 'LOW', note: 'Reads only this business\'s approved knowledge.' },
  { id: 'catalog.search', label: 'Search the product catalog', kind: 'INTERNAL_READ', enabled: true, requiresConfirmation: false, risk: 'LOW', note: 'Reads only this business\'s catalog.' },
  { id: 'usage.summary', label: 'Read usage figures', kind: 'INTERNAL_READ', enabled: true, requiresConfirmation: false, risk: 'LOW', note: 'Read-only counters of this business.' },
  { id: 'draft.save', label: 'Save a draft for review', kind: 'INTERNAL_WRITE', enabled: true, requiresConfirmation: true, risk: 'MEDIUM', note: 'Creates a draft only; a person approves before anything leaves TOUMA.' },
  { id: 'social.publish', label: 'Publish to a social network', kind: 'EXTERNAL', enabled: false, requiresConfirmation: true, risk: 'HIGH', note: 'Needs a connected account, the publishing policy and a consent; disabled in this slice.' },
  { id: 'email.send', label: 'Send an e-mail', kind: 'EXTERNAL', enabled: false, requiresConfirmation: true, risk: 'HIGH', note: 'No mail connector is authorized; disabled.' },
  { id: 'calendar.create', label: 'Create a calendar event', kind: 'EXTERNAL', enabled: false, requiresConfirmation: true, risk: 'MEDIUM', note: 'No calendar connector is authorized; disabled.' },
  { id: 'webhook.call', label: 'Call a custom webhook', kind: 'EXTERNAL', enabled: false, requiresConfirmation: true, risk: 'HIGH', note: 'Outbound calls are not allowed in this slice; disabled.' },
];
export const toolSpec = (id: string) => BUILDER_TOOLS.find((t) => t.id === id) ?? null;

export interface AgentBuilderConfig {
  name: string;
  category: AgentCategory;
  mission: string;
  instructions: string;
  provider: (typeof BUILDER_PROVIDERS)[number];
  model: string;
  language: (typeof BUILDER_LANGUAGES)[number];
  tone: (typeof BUILDER_TONES)[number];
  tools: string[];
  safety: { maxOutputTokens: number; maxCallsPerRun: number; maxRunsPerDay: number; acknowledgeAuto: boolean };
  /** The agent's own preference. The effective behaviour is never looser than the publishing policy of the account (N21). */
  mode: 'AUTO' | 'HYBRID';
  schedule: { timezone: string; hours: HoursWindow[] };
  budget: { monthlyMicros: number; perRunMicros: number };
}
export interface BuilderIssue { path: string; code: string; message: string; severity: 'error' | 'warning' }

export const defaultBuilderConfig = (): AgentBuilderConfig => ({
  name: '', category: 'CUSTOM', mission: '', instructions: '', provider: 'mock', model: MOCK_MODEL, language: 'en', tone: 'friendly', tools: ['knowledge.lookup'],
  safety: { maxOutputTokens: 600, maxCallsPerRun: 3, maxRunsPerDay: 20, acknowledgeAuto: false }, mode: 'HYBRID',
  schedule: { timezone: 'UTC', hours: [{ days: [0, 1, 2, 3, 4, 5, 6], from: '08:00', to: '21:00' }] }, budget: { monthlyMicros: 1_000_000, perRunMicros: 50_000 },
});

const PERSONAL = /[\w.+-]+@[\w-]+\.[\w.-]{2,}|(?<![\d.])\+?\d[\d\s().-]{8,}\d(?![\d.])/;
const SECRET = /(sk-[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{12,}|-----BEGIN [A-Z ]*PRIVATE KEY|Bearer\s+[A-Za-z0-9._-]{20,})/;
// Instructions that try to switch off the server's rules are refused outright: user text can never replace them.
const OVERRIDE = /(ignore|disregard|forget)\s+(all\s+|any\s+|the\s+)?(previous|prior|above|server|system|safety)\s+(instructions|rules|policies)|disable\s+(the\s+)?(safety|approval|policy|guardrails?)|without\s+(asking|approval|permission)|bypass\s+(the\s+)?(approval|policy|limits?)/i;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Normalizes whatever the client sent into a full config (missing parts take the safe defaults). Unknown keys are dropped. */
export function normalizeConfig(raw: unknown): AgentBuilderConfig {
  const d = defaultBuilderConfig();
  const r = isObj(raw) ? raw : {};
  const s = isObj(r.safety) ? r.safety : {}, sc = isObj(r.schedule) ? r.schedule : {}, b = isObj(r.budget) ? r.budget : {};
  const str = (v: unknown, fb: string) => (typeof v === 'string' ? v : fb);
  return {
    name: str(r.name, d.name).trim(), category: AGENT_CATEGORIES.includes(r.category as never) ? (r.category as AgentCategory) : d.category,
    mission: str(r.mission, d.mission).trim(), instructions: str(r.instructions, d.instructions).trim(),
    provider: BUILDER_PROVIDERS.includes(r.provider as never) ? (r.provider as AgentBuilderConfig['provider']) : d.provider, model: str(r.model, d.model).trim(),
    language: BUILDER_LANGUAGES.includes(r.language as never) ? (r.language as AgentBuilderConfig['language']) : d.language, tone: BUILDER_TONES.includes(r.tone as never) ? (r.tone as AgentBuilderConfig['tone']) : d.tone,
    tools: Array.isArray(r.tools) ? [...new Set(r.tools.filter((t): t is string => typeof t === 'string'))].slice(0, 20) : d.tools,
    safety: { maxOutputTokens: num(s.maxOutputTokens) ?? d.safety.maxOutputTokens, maxCallsPerRun: num(s.maxCallsPerRun) ?? d.safety.maxCallsPerRun, maxRunsPerDay: num(s.maxRunsPerDay) ?? d.safety.maxRunsPerDay, acknowledgeAuto: s.acknowledgeAuto === true },
    mode: r.mode === 'AUTO' ? 'AUTO' : 'HYBRID',
    schedule: { timezone: str(sc.timezone, d.schedule.timezone), hours: Array.isArray(sc.hours) ? (sc.hours as HoursWindow[]) : d.schedule.hours },
    budget: { monthlyMicros: num(b.monthlyMicros) ?? d.budget.monthlyMicros, perRunMicros: num(b.perRunMicros) ?? d.budget.perRunMicros },
  };
}

export function validateBuilderConfig(c: AgentBuilderConfig, o: { allowedModels: readonly string[]; maxMonthlyMicros?: number | null }): BuilderIssue[] {
  const out: BuilderIssue[] = [];
  const err = (path: string, code: string, message: string) => out.push({ path, code, message, severity: 'error' });
  const warn = (path: string, code: string, message: string) => out.push({ path, code, message, severity: 'warning' });
  if (c.name.length < 2 || c.name.length > 60) err('name', 'NAME_LENGTH', 'The name must have 2 to 60 characters');
  if (c.mission.length < 10) err('mission', 'MISSION_REQUIRED', 'Describe the mission in at least 10 characters');
  if (c.mission.length > 500) err('mission', 'MISSION_TOO_LONG', 'The mission is limited to 500 characters');
  if (c.instructions.length < 10) err('instructions', 'INSTRUCTIONS_REQUIRED', 'Give the agent instructions (at least 10 characters)');
  if (c.instructions.length > 4000) err('instructions', 'INSTRUCTIONS_TOO_LONG', 'Instructions are limited to 4000 characters');
  for (const f of ['name', 'mission', 'instructions'] as const) {
    if (PERSONAL.test(c[f])) err(f, 'PERSONAL_DATA', 'Do not put e-mail addresses or phone numbers in the agent definition');
    if (SECRET.test(c[f])) err(f, 'SECRET_IN_TEXT', 'The text looks like it contains a key or secret: remove it');
  }
  if (OVERRIDE.test(`${c.mission}\n${c.instructions}`)) err('instructions', 'RULE_OVERRIDE', 'Instructions cannot switch off approvals, limits or safety rules: those are enforced by the server');
  if (c.provider === 'openai') warn('provider', 'PROVIDER_NOT_CONNECTED', 'The real AI provider is not enabled: tests always use the simulator, and activation will need an authorized provider');
  if (c.provider === 'mock' ? c.model !== MOCK_MODEL : !o.allowedModels.includes(c.model)) err('model', 'MODEL_NOT_ALLOWED', 'This model is not on the list of models allowed by the server');
  for (const t of c.tools) {
    const spec = toolSpec(t);
    if (!spec) err('tools', 'TOOL_UNKNOWN', `Unknown tool "${t}"`);
    else if (!spec.enabled) err('tools', 'TOOL_NOT_CONNECTED', `"${spec.label}" needs an authorized connection and is disabled: remove it for now`);
  }
  const s = c.safety;
  if (!Number.isInteger(s.maxOutputTokens) || s.maxOutputTokens < 100 || s.maxOutputTokens > 2000) err('safety.maxOutputTokens', 'RANGE', 'Output size must be between 100 and 2000 tokens');
  if (!Number.isInteger(s.maxCallsPerRun) || s.maxCallsPerRun < 1 || s.maxCallsPerRun > 10) err('safety.maxCallsPerRun', 'RANGE', 'Model calls per run must be between 1 and 10');
  if (!Number.isInteger(s.maxRunsPerDay) || s.maxRunsPerDay < 1 || s.maxRunsPerDay > 200) err('safety.maxRunsPerDay', 'RANGE', 'Runs per day must be between 1 and 200');
  if (c.mode === 'AUTO' && !s.acknowledgeAuto) err('mode', 'AUTO_ACK_REQUIRED', 'AUTO needs your explicit acknowledgement: actions still follow your publishing policy and anything risky still waits for you');
  if (c.mode === 'AUTO' && c.tools.some((t) => toolSpec(t)?.kind === 'INTERNAL_WRITE')) warn('mode', 'AUTO_WRITES', 'In AUTO the agent may save drafts without asking; publication still follows the publishing policy');
  if (!validateHours(c.schedule.hours)) err('schedule.hours', 'HOURS_INVALID', 'Working hours are invalid');
  try { new Intl.DateTimeFormat('en', { timeZone: c.schedule.timezone }); } catch { err('schedule.timezone', 'TIMEZONE_INVALID', 'Unknown timezone'); }
  const b = c.budget;
  if (!Number.isInteger(b.monthlyMicros) || b.monthlyMicros < 0 || b.monthlyMicros > 1_000_000_000) err('budget.monthlyMicros', 'RANGE', 'The monthly budget is invalid');
  if (!Number.isInteger(b.perRunMicros) || b.perRunMicros < 0 || b.perRunMicros > b.monthlyMicros) err('budget.perRunMicros', 'RANGE', 'The per-run budget cannot exceed the monthly budget');
  if (o.maxMonthlyMicros != null && b.monthlyMicros > o.maxMonthlyMicros) err('budget.monthlyMicros', 'BUDGET_ABOVE_PLAN', 'This budget is above what your plan allows');
  return out;
}
export const hasErrors = (i: BuilderIssue[]) => i.some((x) => x.severity === 'error');
