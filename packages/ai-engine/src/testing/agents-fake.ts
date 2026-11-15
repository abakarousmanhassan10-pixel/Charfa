import type { GenerateRequest } from '../provider';

function block(user: string, tag: string): Record<string, unknown> {
  const m = new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n</${tag}>`).exec(user);
  try { return m ? JSON.parse(m[1]!) : {}; } catch { return {}; }
}

/** Deterministic answers for the N28 agent schemas (agent_research, agent_content, ...), built only from the delimited data of the request. undefined = not an agent request. */
export function agentFakeAnswer(req: GenerateRequest): Record<string, unknown> | undefined {
  if (!req.schemaName.startsWith('agent_')) return undefined;
  const data = block(req.user, 'agent_data') as { topic?: string; channel?: string; facts?: Array<{ name?: string; id?: string; price?: string; currency?: string }>; prior?: Record<string, { summary?: string; findings?: string[] }>; usage?: { calls?: number; tokens?: number } };
  const topic = String(data.topic ?? 'the business');
  const facts = data.facts ?? [];
  const names = facts.map((f) => f.name).filter((n): n is string => Boolean(n));
  switch (req.schemaName) {
    case 'agent_research':
      return { summary: `Analysis of ${topic}: ${names.length} verified item(s) found in the catalog.`, findings: names.slice(0, 5).map((n) => `${n} is an active item of the catalog.`), sources: facts.map((f) => f.id).filter((x): x is string => Boolean(x)).slice(0, 5), caveats: ['Only verified catalog data was used; nothing was invented.'] };
    case 'agent_content': {
      const lead = names[0] ?? topic;
      return { title: `Discover ${lead}`, body: `${lead}: prepared with care for our customers. Ask us for details.`, hashtags: ['local', 'quality'], callToAction: 'Send us a message', platform: data.channel ?? 'INSTAGRAM' };
    }
    case 'agent_support':
      return { reply: `Thank you for your message about ${topic}. A member of our team will confirm the details shortly.`, needsHuman: names.length === 0, reason: names.length === 0 ? 'No verified fact covers this question.' : 'Answered from verified catalog facts.' };
    case 'agent_analytics':
      return { summary: `Usage this period: ${data.usage?.calls ?? 0} agent call(s).`, highlights: [`${data.usage?.tokens ?? 0} token(s) used.`], caveats: ['Costs are estimates from the price table, not an invoice.'] };
    case 'agent_supervisor': {
      const draft = String((data.prior?.content as { summary?: string } | undefined)?.summary ?? '');
      const issues = /guarantee|100%|free money/i.test(draft) ? ['The draft contains a claim that cannot be verified.'] : [];
      return { verdict: issues.length ? 'ISSUES' : 'OK', issues, notes: issues.length ? 'Review before approving.' : 'No rule violation found. A human decision is still required.' };
    }
    default:
      return undefined;
  }
}
