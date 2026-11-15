import { BUILDER_TOOLS, MOCK_MODEL, toolSpec, validateBuilderConfig, type AgentBuilderConfig, type BuilderIssue } from './agent-builder';

/**
 * TOUMA agent marketplace (N24). A listing is public catalog data; a PACKAGE VERSION is an immutable, schema-validated manifest. A manifest is DATA: it holds the
 * agent's instructions and declarations, never code, keys, tokens, URLs to execute or any client's private data, and nothing in it is ever executed by the platform.
 * Everything here is pure; the API validates again and a database trigger keeps published versions immutable.
 */
export const MARKETPLACE_STATUSES = ['DRAFT', 'SUBMITTED', 'IN_REVIEW', 'APPROVED', 'REJECTED', 'PUBLISHED', 'SUSPENDED', 'ARCHIVED'] as const;
export type MarketplaceStatusName = (typeof MARKETPLACE_STATUSES)[number];
export const PRICING_TYPES = ['FREE', 'PREMIUM'] as const;
export type PricingType = (typeof PRICING_TYPES)[number];
export const MANIFEST_SCHEMA_VERSION = 1;

export interface AgentManifestV1 {
  schemaVersion: 1;
  /** Stable reverse-style identifier, lower-case: `studio.marketing-pro`. */
  id: string;
  /** Semantic version MAJOR.MINOR.PATCH. A published version is never changed. */
  version: string;
  name: string;
  summary: string;
  category: string;
  tags: string[];
  /** The agent itself, in the same format the no-code builder produces (instructions, tools, limits, budget...). */
  agent: AgentBuilderConfig;
  /** Workflow definitions the package brings (data only). Empty in the first catalog release. */
  workflows: unknown[];
  /** Values the installing client fills in (never secrets). */
  variables: Array<{ key: string; label: string; type: 'text' | 'number' | 'boolean'; default?: string | number | boolean }>;
  recommendedBudget: { monthlyMicros: number };
  compatibleModels: string[];
  license: { type: 'FREE' | 'PREMIUM_SIMULATED'; terms: string };
  author: { name: string };
  /** What the package needs from the client, declared by the author and checked against the tools: the install screen shows exactly this. */
  permissions: Array<{ key: string; description: string; sensitive: boolean }>;
}

export interface ManifestIssue { path: string; code: string; message: string }
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SLUG = /^[a-z0-9]+([.-][a-z0-9]+)*$/;
export const isSlug = (s: string) => s.length >= 3 && s.length <= 80 && SLUG.test(s);
export const isSemver = (s: string) => SEMVER.test(s);
export function compareSemver(a: string, b: string): number {
  const [x, y] = [a, b].map((v) => v.split('.').map(Number)) as [number[], number[]];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
}

/** What each tool needs from the client, in plain words. Derived, so the declared list can be checked against it. */
const TOOL_PERMISSION: Record<string, { key: string; description: string; sensitive: boolean }> = {
  'knowledge.lookup': { key: 'read.knowledge', description: 'Read your approved business knowledge', sensitive: false },
  'catalog.search': { key: 'read.catalog', description: 'Read your product catalog', sensitive: false },
  'usage.summary': { key: 'read.usage', description: 'Read your usage counters', sensitive: false },
  'draft.save': { key: 'write.drafts', description: 'Create drafts for your review (nothing is published without your approval)', sensitive: true },
  'social.publish': { key: 'external.social', description: 'Publish to your connected social accounts', sensitive: true },
  'email.send': { key: 'external.email', description: 'Send e-mail from your connected mailbox', sensitive: true },
  'calendar.create': { key: 'external.calendar', description: 'Create events in your connected calendar', sensitive: true },
  'webhook.call': { key: 'external.webhook', description: 'Call an outbound webhook', sensitive: true },
};
export const derivePermissions = (tools: string[]) => [...new Map(tools.filter((t) => TOOL_PERMISSION[t]).map((t) => [TOOL_PERMISSION[t]!.key, TOOL_PERMISSION[t]!])).values()];

/** Capabilities in plain words, from the agent's tools (never from marketing text). */
export const deriveCapabilities = (tools: string[]) => tools.map((t) => toolSpec(t)).filter((s): s is NonNullable<ReturnType<typeof toolSpec>> => !!s).map((s) => ({ tool: s.id, label: s.label, kind: s.kind, requiresConfirmation: s.requiresConfirmation, enabledToday: s.enabled }));

const SECRET = /(sk-[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{12,}|-----BEGIN [A-Z ]*PRIVATE KEY|Bearer\s+[A-Za-z0-9._-]{20,}|xox[bp]-[A-Za-z0-9-]{10,}|ghp_[A-Za-z0-9]{20,})/;
const URLISH = /(https?:\/\/|wss?:\/\/|ftp:\/\/|\b[a-z0-9-]+\.(com|net|org|io|app|dev|xyz|ru|cn|tk)\b)/i;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Structural validation of a manifest. It checks shape, bounds, that the declared permissions equal the ones derived from the tools (nothing hidden, nothing
 * extra), that only registry tools are used, that no secret/URL/code-like field exists, and the agent part with the builder's own rules. It does NOT decide whether
 * a package is safe to publish: that is the security gateway plus human review (next block).
 */
export function validateManifest(raw: unknown, o: { allowedModels?: readonly string[] } = {}): { ok: true; manifest: AgentManifestV1; issues: ManifestIssue[] } | { ok: false; issues: ManifestIssue[] } {
  const issues: ManifestIssue[] = [];
  const bad = (path: string, code: string, message: string) => issues.push({ path, code, message });
  if (!isObj(raw)) return { ok: false, issues: [{ path: '', code: 'NOT_AN_OBJECT', message: 'The manifest must be a JSON object' }] };
  const allowedKeys = ['schemaVersion', 'id', 'version', 'name', 'summary', 'category', 'tags', 'agent', 'workflows', 'variables', 'recommendedBudget', 'compatibleModels', 'license', 'author', 'permissions'];
  for (const k of Object.keys(raw)) if (!allowedKeys.includes(k)) bad(k, 'UNKNOWN_FIELD', `Unknown field "${k}" (a manifest is data only: no scripts, hooks or code)`);
  if (raw.schemaVersion !== MANIFEST_SCHEMA_VERSION) bad('schemaVersion', 'SCHEMA_VERSION', `schemaVersion must be ${MANIFEST_SCHEMA_VERSION}`);
  if (typeof raw.id !== 'string' || !isSlug(raw.id)) bad('id', 'ID_INVALID', 'id must be 3-80 lower-case letters, digits, dots or dashes');
  if (typeof raw.version !== 'string' || !isSemver(raw.version)) bad('version', 'VERSION_INVALID', 'version must be MAJOR.MINOR.PATCH');
  const text = (k: 'name' | 'summary', min: number, max: number) => { const v = raw[k]; if (typeof v !== 'string' || v.trim().length < min || v.trim().length > max) bad(k, 'TEXT_LENGTH', `${k} must have ${min} to ${max} characters`); };
  text('name', 2, 80); text('summary', 10, 300);
  if (typeof raw.category !== 'string') bad('category', 'CATEGORY', 'category is required');
  if (!Array.isArray(raw.tags) || raw.tags.length > 10 || raw.tags.some((t) => typeof t !== 'string' || t.length > 30)) bad('tags', 'TAGS', 'tags: up to 10 short strings');
  if (!Array.isArray(raw.workflows) || raw.workflows.length > 5) bad('workflows', 'WORKFLOWS', 'workflows must be a list of at most 5 definitions');
  if (!Array.isArray(raw.variables) || raw.variables.length > 20 || raw.variables.some((v) => !isObj(v) || typeof v.key !== 'string' || !/^[a-z][a-zA-Z0-9_]{0,30}$/.test(v.key) || typeof v.label !== 'string' || !['text', 'number', 'boolean'].includes(v.type as string))) bad('variables', 'VARIABLES', 'variables: up to 20 entries {key,label,type}');
  if (!isObj(raw.recommendedBudget) || !Number.isInteger(raw.recommendedBudget.monthlyMicros) || (raw.recommendedBudget.monthlyMicros as number) < 0 || (raw.recommendedBudget.monthlyMicros as number) > 1_000_000_000) bad('recommendedBudget', 'BUDGET', 'recommendedBudget.monthlyMicros must be a non-negative integer');
  if (!Array.isArray(raw.compatibleModels) || !raw.compatibleModels.length || raw.compatibleModels.some((m) => typeof m !== 'string')) bad('compatibleModels', 'MODELS', 'compatibleModels must list at least one model');
  if (!isObj(raw.license) || !['FREE', 'PREMIUM_SIMULATED'].includes(raw.license.type as string) || typeof raw.license.terms !== 'string' || (raw.license.terms as string).length < 5 || (raw.license.terms as string).length > 2000) bad('license', 'LICENSE', 'license needs a type (FREE or PREMIUM_SIMULATED) and terms');
  if (!isObj(raw.author) || typeof raw.author.name !== 'string' || raw.author.name.length < 2 || raw.author.name.length > 80) bad('author', 'AUTHOR', 'author.name is required');
  // No secret, URL or address anywhere in the package text.
  const blob = JSON.stringify(raw);
  if (SECRET.test(blob)) bad('', 'SECRET_IN_PACKAGE', 'The package contains something that looks like a key or token');
  if (URLISH.test(blob)) bad('', 'URL_IN_PACKAGE', 'The package contains a URL or host name: packages are data only and cannot reference external endpoints');
  // The agent part uses the builder's rules (instructions, tools, limits...).
  let agentIssues: BuilderIssue[] = [];
  if (!isObj(raw.agent)) bad('agent', 'AGENT_REQUIRED', 'agent is required');
  else {
    const a = raw.agent as unknown as AgentBuilderConfig;
    agentIssues = validateBuilderConfig(a, { allowedModels: [MOCK_MODEL, ...(o.allowedModels ?? [])] });
    for (const i of agentIssues.filter((x) => x.severity === 'error')) bad(`agent.${i.path}`, i.code, i.message);
    if (Array.isArray(a.tools) && Array.isArray(raw.permissions)) {
      const derived = derivePermissions(a.tools).map((p) => p.key).sort();
      const declared = (raw.permissions as Array<{ key?: unknown }>).map((p) => String(p?.key)).sort();
      if (JSON.stringify(derived) !== JSON.stringify(declared)) bad('permissions', 'PERMISSIONS_MISMATCH', `Declared permissions must match the tools exactly (expected: ${derived.join(', ') || 'none'})`);
    } else if (!Array.isArray(raw.permissions)) bad('permissions', 'PERMISSIONS', 'permissions must be a list');
    if (Array.isArray(raw.compatibleModels) && !raw.compatibleModels.includes(a.model)) bad('compatibleModels', 'MODEL_NOT_LISTED', 'The agent\'s own model must be in compatibleModels');
  }
  return issues.length ? { ok: false, issues } : { ok: true, manifest: raw as unknown as AgentManifestV1, issues };
}

export const knownTools = () => BUILDER_TOOLS.map((t) => t.id);
