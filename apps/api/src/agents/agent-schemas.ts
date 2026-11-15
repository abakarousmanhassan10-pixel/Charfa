import { z } from 'zod';

/** Structured outputs of the agents: strict JSON Schemas for the provider (Responses API structured output) and the matching validators. Output is validated, never trusted. */
const str = (max: number) => ({ type: 'string', maxLength: max });
const strList = (max: number, items: number) => ({ type: 'array', items: str(max), maxItems: items });
const obj = (properties: Record<string, unknown>) => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });

export const AGENT_SCHEMAS = {
  RESEARCH: { name: 'agent_research', json: obj({ summary: str(600), findings: strList(300, 5), sources: strList(60, 5), caveats: strList(200, 3) }), zod: z.object({ summary: z.string().max(600), findings: z.array(z.string().max(300)).max(5), sources: z.array(z.string().max(60)).max(5), caveats: z.array(z.string().max(200)).max(3) }).strict() },
  CONTENT: { name: 'agent_content', json: obj({ title: str(120), body: str(2200), hashtags: strList(40, 10), callToAction: str(200), platform: { type: 'string', enum: ['INSTAGRAM', 'FACEBOOK', 'TIKTOK', 'YOUTUBE', 'LINKEDIN'] } }), zod: z.object({ title: z.string().min(1).max(120), body: z.string().min(1).max(2200), hashtags: z.array(z.string().regex(/^[\p{L}\p{N}_]{1,40}$/u)).max(10), callToAction: z.string().max(200), platform: z.enum(['INSTAGRAM', 'FACEBOOK', 'TIKTOK', 'YOUTUBE', 'LINKEDIN']) }).strict() },
  SUPPORT: { name: 'agent_support', json: obj({ reply: str(1000), needsHuman: { type: 'boolean' }, reason: str(300) }), zod: z.object({ reply: z.string().min(1).max(1000), needsHuman: z.boolean(), reason: z.string().max(300) }).strict() },
  ANALYTICS: { name: 'agent_analytics', json: obj({ summary: str(800), highlights: strList(300, 5), caveats: strList(200, 3) }), zod: z.object({ summary: z.string().max(800), highlights: z.array(z.string().max(300)).max(5), caveats: z.array(z.string().max(200)).max(3) }).strict() },
  SUPERVISOR: { name: 'agent_supervisor', json: obj({ verdict: { type: 'string', enum: ['OK', 'ISSUES'] }, issues: strList(300, 8), notes: str(400) }), zod: z.object({ verdict: z.enum(['OK', 'ISSUES']), issues: z.array(z.string().max(300)).max(8), notes: z.string().max(400) }).strict() },
} as const;
