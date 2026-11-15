import { z } from 'zod';
import type { PlanAgent } from './entitlements';

/**
 * AI agents of TOUMA (N28): the catalog, the validated per-agent configuration, the task state machine and the integer cost arithmetic.
 * Pure code: the server enforces everything here; a browser can neither widen an agent's permissions nor change a limit.
 */

export const AGENT_TYPES = ['RESEARCH', 'CONTENT', 'SUPPORT', 'ANALYTICS', 'SUPERVISOR'] as const;
export type AgentTypeName = (typeof AGENT_TYPES)[number];

/** What an agent may be allowed to do. None of them acts outside TOUMA: publishing and sending always need a human decision. */
export const AGENT_PERMISSIONS = ['catalog.read', 'knowledge.read', 'content.draft', 'support.draft', 'analytics.read', 'run.review'] as const;
export type AgentPermission = (typeof AGENT_PERMISSIONS)[number];

/** Tools declared in the registry. `content.save_draft` creates a draft IN REVIEW; there is no tool that publishes, sends or spends. */
export const AGENT_TOOLS = ['catalog.search', 'knowledge.lookup', 'usage.summary', 'content.save_draft', 'support.save_reply_draft'] as const;
export type AgentToolName = (typeof AGENT_TOOLS)[number];

export const MODEL_TIERS = ['economy', 'standard', 'advanced', 'auto'] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];

export interface AgentCatalogEntry {
  label: string;
  role: string;
  permissions: AgentPermission[];
  tools: AgentToolName[];
  /** The plan entitlement (AI agent) this type consumes; null = available with any plan that includes the agents feature. */
  planAgent: PlanAgent | null;
  complexity: 'simple' | 'complex';
  defaults: { modelTier: ModelTier; maxOutputTokens: number; maxCostPerRunMicros: number; maxCallsPerDay: number; concurrency: number };
}

export const AGENT_CATALOG: Readonly<Record<AgentTypeName, AgentCatalogEntry>> = {
  RESEARCH: { label: 'ResearchAgent', role: 'Researches and analyses the business catalog and knowledge to prepare facts for other agents', permissions: ['catalog.read', 'knowledge.read'], tools: ['catalog.search', 'knowledge.lookup'], planAgent: 'BUSINESS_ANALYST', complexity: 'complex', defaults: { modelTier: 'auto', maxOutputTokens: 1200, maxCostPerRunMicros: 200_000, maxCallsPerDay: 50, concurrency: 2 } },
  CONTENT: { label: 'ContentAgent', role: 'Writes and prepares content drafts from verified facts; every draft waits for a human approval', permissions: ['catalog.read', 'content.draft'], tools: ['catalog.search', 'content.save_draft'], planAgent: 'CONTENT_CREATOR', complexity: 'complex', defaults: { modelTier: 'auto', maxOutputTokens: 1000, maxCostPerRunMicros: 200_000, maxCallsPerDay: 50, concurrency: 2 } },
  SUPPORT: { label: 'SupportAgent', role: 'Prepares customer replies from verified knowledge; nothing is sent without the configured validation', permissions: ['knowledge.read', 'catalog.read', 'support.draft'], tools: ['knowledge.lookup', 'catalog.search', 'support.save_reply_draft'], planAgent: 'CUSTOMER_SUPPORT', complexity: 'simple', defaults: { modelTier: 'economy', maxOutputTokens: 600, maxCostPerRunMicros: 100_000, maxCallsPerDay: 200, concurrency: 3 } },
  ANALYTICS: { label: 'AnalyticsAgent', role: 'Measures usage and results and writes plain-language reports; never invents figures', permissions: ['analytics.read'], tools: ['usage.summary'], planAgent: 'PERFORMANCE_ANALYST', complexity: 'simple', defaults: { modelTier: 'economy', maxOutputTokens: 800, maxCostPerRunMicros: 100_000, maxCallsPerDay: 50, concurrency: 1 } },
  SUPERVISOR: { label: 'SupervisorAgent', role: 'Reviews the work of other agents against the rules and flags problems; cannot approve anything', permissions: ['run.review'], tools: [], planAgent: null, complexity: 'complex', defaults: { modelTier: 'advanced', maxOutputTokens: 600, maxCostPerRunMicros: 150_000, maxCallsPerDay: 50, concurrency: 1 } },
};

export const agentConfigSchema = z
  .object({
    role: z.string().trim().min(3).max(300),
    permissions: z.array(z.enum(AGENT_PERMISSIONS)).max(AGENT_PERMISSIONS.length),
    tools: z.array(z.enum(AGENT_TOOLS)).max(AGENT_TOOLS.length),
    modelTier: z.enum(MODEL_TIERS),
    /** An explicit model id (must be in the server's allowed list). Optional: the router chooses from the tier. */
    model: z.string().trim().min(1).max(100).regex(/^[A-Za-z0-9._:/-]+$/).optional(),
    maxOutputTokens: z.number().int().min(64).max(4000),
    /** Per-run spending cap, micro-units of USD. */
    maxCostPerRunMicros: z.number().int().min(0).max(50_000_000),
    maxCallsPerDay: z.number().int().min(1).max(1000),
    concurrency: z.number().int().min(1).max(5),
  })
  .strict();
export type AgentConfig = z.infer<typeof agentConfigSchema>;

/** Which tools each permission unlocks: an agent can only be given a tool its permissions cover. */
export const TOOL_PERMISSION: Readonly<Record<AgentToolName, AgentPermission>> = {
  'catalog.search': 'catalog.read',
  'knowledge.lookup': 'knowledge.read',
  'usage.summary': 'analytics.read',
  'content.save_draft': 'content.draft',
  'support.save_reply_draft': 'support.draft',
};

export function defaultAgentConfig(type: AgentTypeName): AgentConfig {
  const c = AGENT_CATALOG[type];
  return { role: c.role, permissions: [...c.permissions], tools: [...c.tools], ...c.defaults };
}

/** Rejects a configuration whose tools are not covered by its permissions, or that grants more than the catalog allows for this type. */
export function validateAgentConfig(type: AgentTypeName, raw: unknown): { ok: true; config: AgentConfig } | { ok: false; error: string } {
  const parsed = agentConfigSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ') };
  const c = parsed.data;
  const cat = AGENT_CATALOG[type];
  const extraPerm = c.permissions.find((p) => !cat.permissions.includes(p));
  if (extraPerm) return { ok: false, error: `permission ${extraPerm} is not allowed for ${cat.label}` };
  const extraTool = c.tools.find((t) => !cat.tools.includes(t));
  if (extraTool) return { ok: false, error: `tool ${extraTool} is not allowed for ${cat.label}` };
  const uncovered = c.tools.find((t) => !c.permissions.includes(TOOL_PERMISSION[t]));
  if (uncovered) return { ok: false, error: `tool ${uncovered} needs permission ${TOOL_PERMISSION[uncovered]}` };
  return { ok: true, config: c };
}

// ─── Task state machine ────────────────────────────────────────────────────

export const TASK_STATES = ['CREATED', 'QUEUED', 'RUNNING', 'WAITING_APPROVAL', 'COMPLETED', 'FAILED', 'CANCELED', 'BLOCKED'] as const;
export type TaskState = (typeof TASK_STATES)[number];

/** CREATED -> QUEUED (admitted) or BLOCKED (refused); QUEUED -> RUNNING; RUNNING -> WAITING_APPROVAL | COMPLETED | FAILED | BLOCKED; a human decision moves WAITING_APPROVAL on. BLOCKED/FAILED can be retried once the cause is fixed. */
export const TASK_TRANSITIONS: Record<TaskState, readonly TaskState[]> = {
  CREATED: ['QUEUED', 'BLOCKED', 'CANCELED'],
  QUEUED: ['RUNNING', 'BLOCKED', 'CANCELED', 'FAILED'],
  RUNNING: ['WAITING_APPROVAL', 'COMPLETED', 'FAILED', 'BLOCKED', 'CANCELED', 'QUEUED'],
  WAITING_APPROVAL: ['RUNNING', 'QUEUED', 'COMPLETED', 'FAILED', 'BLOCKED', 'CANCELED'],
  COMPLETED: [],
  FAILED: ['QUEUED'],
  CANCELED: [],
  BLOCKED: ['QUEUED', 'CANCELED'],
};
export const canTaskTransition = (from: TaskState, to: TaskState) => from === to || TASK_TRANSITIONS[from].includes(to);

/** The run engine's statuses expressed as the task states of the product (PENDING = QUEUED; PAUSED shows as QUEUED-on-hold: not a separate customer state). */
export function taskStateOf(runStatus: string): TaskState {
  switch (runStatus) {
    case 'CREATED': return 'CREATED';
    case 'PENDING': case 'PAUSED': return 'QUEUED';
    case 'RUNNING': return 'RUNNING';
    case 'WAITING_APPROVAL': return 'WAITING_APPROVAL';
    case 'COMPLETED': return 'COMPLETED';
    case 'FAILED': return 'FAILED';
    case 'CANCELLED': return 'CANCELED';
    case 'BLOCKED': return 'BLOCKED';
    default: return 'FAILED';
  }
}

// ─── Cost: integer micro-units, never floats ───────────────────────────────

export interface PriceMicros {
  /** micro-units of the currency per million tokens */
  inputPerMillionMicros: number;
  cachedInputPerMillionMicros?: number | null;
  outputPerMillionMicros: number;
}

/**
 * ceil(tokens × price / 1,000,000), in exact integer arithmetic (every intermediate value is a safe integer; anything larger is refused), never rounding a
 * paid call down to zero. Cached input tokens are billed at the cached price when there is one, else at the input price.
 */
export function costMicros(tokens: { input: number; output: number; cached?: number | null }, price: PriceMicros): number {
  const cached = Math.min(Math.max(Math.trunc(tokens.cached ?? 0), 0), Math.trunc(tokens.input));
  const fresh = Math.trunc(tokens.input) - cached;
  const cachedPrice = price.cachedInputPerMillionMicros ?? price.inputPerMillionMicros;
  const total = fresh * price.inputPerMillionMicros + cached * cachedPrice + Math.trunc(tokens.output) * price.outputPerMillionMicros;
  if (!Number.isSafeInteger(total) || total < 0) throw new RangeError('Cost out of range');
  const x = total + 999_999;
  let q = Math.floor(x / 1_000_000);
  while (q * 1_000_000 > x) q -= 1;
  while ((q + 1) * 1_000_000 <= x) q += 1;
  return q;
}

/** "0.15" USD per million -> 150000 micro-units per million (exact string arithmetic). */
export function usdPerMillionToMicros(value: string): number {
  const m = /^(\d{1,6})(?:\.(\d{1,6}))?$/.exec(value.trim());
  if (!m) throw new RangeError('Invalid price');
  return Number(m[1] + (m[2] ?? '').padEnd(6, '0'));
}
export const microsToUsdString = (micros: number): string => {
  const s = String(Math.trunc(micros)).padStart(7, '0');
  return `${s.slice(0, -6)}.${s.slice(-6)}`;
};
