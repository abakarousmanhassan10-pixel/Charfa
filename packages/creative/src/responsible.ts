/**
 * Responsible-content rules for the Creative Studio (N25). Pure, server-side; the browser form only mirrors them.
 * They do not replace the provider's own policies or a human review: they refuse the obvious, record what the client declared, and keep the AI disclosure on.
 */
export interface ResponsibleInput { hasReferencePhoto: boolean; rightsConfirmed?: boolean; containsPerson?: boolean; personConsent?: boolean; text: string }
export interface ResponsibleIssue { code: 'RIGHTS_CONFIRMATION_REQUIRED' | 'PERSON_CONSENT_REQUIRED' | 'CONTENT_NOT_ALLOWED'; message: string }

const BLOCKED: Array<{ re: RegExp; why: string }> = [
  { re: /\b(child|minor|underage|kid|teen)\b.{0,40}\b(nude|naked|sexual|erotic)\b|\b(nude|naked|sexual|erotic)\b.{0,40}\b(child|minor|underage|kid|teen)\b/i, why: 'sexual content involving minors' },
  { re: /\b(gore|dismember|beheading|graphic violence)\b/i, why: 'graphic violence' },
  { re: /\b(deepfake|fake (video|photo|image) of|impersonat\w+)\b/i, why: 'impersonation or deepfakes' },
  { re: /\b(fake|fabricated|invented)\s+(review|testimonial|endorsement|certification|award)s?\b|\bendorsed by\b|\bapproved by (the )?(who|fda|ministry)\b/i, why: 'invented reviews, endorsements or certifications' },
  { re: /\b(cures?|miracle|guaranteed results?|risk[- ]free|get rich|lose \d+\s?(kg|lbs?))\b|\bavant[- ]apr[eè]s\b.{0,20}\b(sant[eé]|maigrir)\b/i, why: 'misleading health or income claims' },
  { re: /\b(counterfeit|replica of|copy of the logo of)\b/i, why: 'counterfeit or copyright-infringing material' },
];

export function checkResponsibleRequest(i: ResponsibleInput): ResponsibleIssue[] {
  const out: ResponsibleIssue[] = [];
  if (i.hasReferencePhoto && i.rightsConfirmed !== true) out.push({ code: 'RIGHTS_CONFIRMATION_REQUIRED', message: 'Confirm that you own the photo or have the right to use and modify it before it is sent for generation' });
  if (i.containsPerson === true && i.personConsent !== true) out.push({ code: 'PERSON_CONSENT_REQUIRED', message: 'A real person appears: confirm that this person agreed to the use of their image' });
  for (const b of BLOCKED) if (b.re.test(i.text)) out.push({ code: 'CONTENT_NOT_ALLOWED', message: `This request cannot be processed: ${b.why}` });
  return out;
}

/** What the client declared for this generation, stored with it. */
export interface ResponsibleRecord { rightsConfirmed: boolean; containsPerson: boolean; personConsent: boolean; aiDisclosure: boolean }
export const AI_DISCLOSURE_NOTE = 'AI-generated or AI-edited media: some platforms require this to be disclosed when it looks realistic. Check each platform\'s current rules before publishing.';

/**
 * Providers the studio knows about and what is actually true of each. Nothing is integrated just because it is listed: model names come from configuration and
 * contracts, prices and parameters must be verified before any integration (statuses below say what was and was not done).
 */
export interface CreativeProviderInfo { id: string; kind: 'image' | 'video'; status: 'SIMULATED' | 'IMPLEMENTED_UNVERIFIED' | 'NOT_IMPLEMENTED'; note: string }
export const CREATIVE_PROVIDER_REGISTRY: readonly CreativeProviderInfo[] = [
  { id: 'mock', kind: 'image', status: 'SIMULATED', note: 'Simulator: produces labelled placeholder images, no model call, no cost. Never offered in production.' },
  { id: 'mock', kind: 'video', status: 'SIMULATED', note: 'Simulator: produces an empty valid video file, no model call, no cost. Never offered in production.' },
  { id: 'openai', kind: 'image', status: 'IMPLEMENTED_UNVERIFIED', note: 'OpenAI Images API adapter tested only against stubbed responses. The model name comes from IMAGE_MODEL; current model names, parameters and prices must be checked against OpenAI\'s documentation before first use.' },
  { id: 'openai', kind: 'video', status: 'IMPLEMENTED_UNVERIFIED', note: 'Adapter tested only against stubbed responses. VIDEO_MODEL must be set explicitly; no model is assumed and the retired Sora 2 API is not a default.' },
  { id: 'higgsfield', kind: 'video', status: 'NOT_IMPLEMENTED', note: 'Considered as primary video provider. A disabled placeholder class exists (it never connects); API contract, models, parameters and pricing have not been verified.' },
  { id: 'kling', kind: 'video', status: 'NOT_IMPLEMENTED', note: 'Considered as alternative video provider. Contract and pricing not verified: no integration exists.' },
];
