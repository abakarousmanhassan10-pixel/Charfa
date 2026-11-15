import { createHash } from 'crypto';
import { detectInjection, sanitizeUntrusted } from '@touma/ai-engine';
import { toolSpec, type AgentBuilderConfig } from '@touma/shared';

export interface TraceStep { step: string; status: 'OK' | 'FLAGGED' | 'REFUSED' | 'SIMULATED' | 'INFO'; detail: string }
export interface SandboxResult { status: 'COMPLETED' | 'REFUSED'; output: { reply: string; proposedActions: Array<{ tool: string; outcome: string; reason: string }>; modeEffect: string } | null; trace: TraceStep[]; inputTokens: number; outputTokens: number }

/** What the user's request seems to ask for, by plain keywords. Only used to show which tool calls would be attempted; nothing is executed. */
const INTENTS: Array<{ tool: string; re: RegExp }> = [
  { tool: 'social.publish', re: /\b(publish|post it|post this|go live|poste[rz]?|publie[rz]?)\b/i },
  { tool: 'email.send', re: /\b(e-?mail|send (a )?mail|envoy(er|ez) (un )?(mail|courriel))\b/i },
  { tool: 'webhook.call', re: /\b(webhook|call (the )?api|appelle[rz]? l'api)\b/i },
  { tool: 'calendar.create', re: /\b(schedule a meeting|create (an )?event|calendar invite|planifie[rz]? (un )?rendez-vous)\b/i },
  { tool: 'catalog.search', re: /\b(product|catalog|price|produit|catalogue|prix)\b/i },
  { tool: 'knowledge.lookup', re: /\b(faq|opening hours|policy|how (do|does)|horaires|politique)\b/i },
  { tool: 'draft.save', re: /\b(draft|brouillon|write (a )?(post|reply)|r[ée]dige)\b/i },
  { tool: 'usage.summary', re: /\b(usage|quota|consumption|consommation)\b/i },
];

/**
 * The SIMULATED test of an agent (N23). A deterministic stand-in for a model: it reads the definition, applies the same least-privilege rules the real engine
 * will apply, and writes a plausible reply from the mission and tone. It calls no model, no tool, no network, reads no business data and costs 0. Its job is to let
 * a person see what the agent would attempt, what would be refused and why, before anything is activated.
 */
export function runSandbox(c: AgentBuilderConfig, rawInput: string): SandboxResult {
  const trace: TraceStep[] = [];
  const input = sanitizeUntrusted(rawInput, 1000);
  trace.push({ step: 'INPUT', status: 'INFO', detail: `${input.length} characters received; treated as data, never as instructions.` });
  const flags = detectInjection(input);
  if (flags.length) trace.push({ step: 'INJECTION_SCAN', status: 'FLAGGED', detail: `The message tries to change the agent's rules (${flags.length} pattern(s)). It is handled as plain text: server rules, tools and limits do not change.` });
  trace.push({ step: 'RULES', status: 'INFO', detail: 'Server rules come first: approvals, limits and the publishing policy cannot be replaced by instructions or messages.' });
  trace.push({ step: 'PROMPT', status: 'INFO', detail: `Prompt assembled from ${c.instructions.length} characters of your instructions, tone "${c.tone}", language "${c.language}" (not sent anywhere).` });
  trace.push({ step: 'MODEL', status: 'SIMULATED', detail: 'Simulator reply: no AI model was called.' });

  // Tool plan: what the request would trigger, checked against the granted tools.
  const wanted = INTENTS.filter((i) => i.re.test(input)).map((i) => i.tool).slice(0, c.safety.maxCallsPerRun);
  const proposed: Array<{ tool: string; outcome: string; reason: string }> = [];
  for (const id of wanted) {
    const spec = toolSpec(id);
    if (!c.tools.includes(id)) { proposed.push({ tool: id, outcome: 'REFUSED', reason: 'This tool was not granted to the agent (least privilege).' }); trace.push({ step: `TOOL ${id}`, status: 'REFUSED', detail: 'Not granted to this agent.' }); continue; }
    if (!spec || !spec.enabled) { proposed.push({ tool: id, outcome: 'REFUSED', reason: 'No authorized connection exists for this tool.' }); trace.push({ step: `TOOL ${id}`, status: 'REFUSED', detail: 'No authorized connection.' }); continue; }
    const needs = spec.requiresConfirmation;
    const outcome = needs ? (c.mode === 'HYBRID' ? 'WOULD_WAIT_FOR_APPROVAL' : 'WOULD_FOLLOW_POLICY') : 'WOULD_RUN';
    proposed.push({ tool: id, outcome, reason: needs ? (c.mode === 'HYBRID' ? 'HYBRID: a person approves this action first.' : 'AUTO: the action still follows your publishing policy and its checks.') : 'Read-only action inside your business data (not executed in the simulator).' });
    trace.push({ step: `TOOL ${id}`, status: 'SIMULATED', detail: `${outcome}: not executed.` });
  }
  const modeEffect = c.mode === 'HYBRID' ? 'HYBRID: anything that writes or leaves TOUMA waits for a person.' : 'AUTO: allowed actions run by themselves, but only inside your publishing policy; risky or sensitive content still waits for a person.';
  trace.push({ step: 'MODE', status: 'INFO', detail: modeEffect });
  trace.push({ step: 'LIMITS', status: 'INFO', detail: `Per run: at most ${c.safety.maxCallsPerRun} call(s), ${c.safety.maxOutputTokens} output tokens, ${(c.budget.perRunMicros / 1_000_000).toFixed(4)} USD budget; the simulator costs 0.` });

  const seed = createHash('sha256').update(`${c.name}|${c.mission}|${input}`).digest('hex').slice(0, 6);
  const snippet = input.replace(/\s+/g, ' ').slice(0, 120);
  const opener = c.language === 'fr' ? 'Réponse simulée' : 'Simulated reply';
  const reply = `[${opener} #${seed}, no AI model was called] ${c.name} (${c.category.toLowerCase()}, ${c.tone}): ${c.mission.slice(0, 140)} — regarding "${snippet}", here is how I would start: a short ${c.tone} draft in ${c.language}, based only on information you authorize${proposed.some((p) => p.outcome === 'REFUSED') ? ', without the actions I am not allowed to take' : ''}.`.slice(0, c.safety.maxOutputTokens * 4);
  const refusedAll = proposed.length > 0 && proposed.every((p) => p.outcome === 'REFUSED');
  return { status: refusedAll ? 'REFUSED' : 'COMPLETED', output: { reply, proposedActions: proposed, modeEffect }, trace, inputTokens: Math.ceil((c.instructions.length + input.length) / 4), outputTokens: Math.ceil(reply.length / 4) };
}
