import type { AppEnv } from './env';

export type GoLiveMode = 'simulated' | 'real' | 'disabled';
export interface GoLiveCapability { id: string; label: string; mode: GoLiveMode; ok: boolean; missing: string[]; note: string }
export interface GoLiveReport { overall: 'SIMULATION' | 'REAL_BLOCKED' | 'REAL_READY'; environment: string; capabilities: GoLiveCapability[]; blockers: string[] }

const priced = (env: AppEnv, model: string) => { const name = model.includes(':') ? model.slice(model.lastIndexOf(':') + 1) : model; return Object.keys(env.CREATIVE_MODEL_PRICING).some((k) => name === k || name.startsWith(k)); };

/**
 * What stands between this configuration and real operation, capability by capability. Pure and secret-free: it only reports booleans and variable NAMES,
 * never a value. "real" with missing items is a blocker; "simulated" is fine for a demo but is not real operation.
 */
export function evaluateGoLive(env: AppEnv): GoLiveReport {
  const caps: GoLiveCapability[] = [];
  const add = (id: string, label: string, mode: GoLiveMode, missing: string[], note: string) => caps.push({ id, label, mode, ok: missing.length === 0 && mode !== 'disabled', missing, note });

  const aiReal = env.AI_PROVIDER === 'openai';
  add('ai-text', 'AI text (analyses, strategy, content)', aiReal ? 'real' : 'simulated',
    aiReal ? [...(env.OPENAI_API_KEY ? [] : ['OPENAI_API_KEY']), ...(Object.keys(env.AI_MODEL_PRICING).length ? [] : ['AI_MODEL_PRICING'])] : [],
    aiReal ? 'Per-business monthly generation and token limits apply.' : 'Deterministic test provider: no model is called.');

  const free = env.CREATIVE_STUDIO_MODE === 'mock';
  const paid = (kind: 'IMAGE' | 'VIDEO') => {
    const provider = kind === 'IMAGE' ? env.IMAGE_PROVIDER : env.VIDEO_PROVIDER;
    const model = kind === 'IMAGE' ? env.IMAGE_MODEL : env.VIDEO_MODEL;
    const label = kind === 'IMAGE' ? 'Creative images' : 'Creative videos';
    const id = kind === 'IMAGE' ? 'creative-images' : 'creative-videos';
    if (provider === 'none') return add(id, label, 'disabled', [], 'No provider active. A real provider needs OPENAI_API_KEY, PAID_GENERATION_ENABLED=true, a platform cap and a price for its model; until then it stays off.');
    if (provider === 'mock' || provider === 'fake') return add(id, label, 'simulated', [], free ? 'Free test mode: labelled demo files, zero cost.' : 'Test provider.');
    if (provider === 'higgsfield') return add(id, label, 'disabled', ['Higgsfield integration (placeholder only, not implemented)'], 'Selecting it is refused at start-up.');
    const missing = [
      ...(env.OPENAI_API_KEY ? [] : ['OPENAI_API_KEY']),
      ...(env.PAID_GENERATION_ENABLED ? [] : ['PAID_GENERATION_ENABLED=true']),
      ...(env.CREATIVE_PLATFORM_MONTHLY_CAP_MICROS > 0 ? [] : ['CREATIVE_PLATFORM_MONTHLY_CAP_MICROS']),
      ...(priced(env, model) ? [] : [`price of ${model} in CREATIVE_MODEL_PRICING`]),
    ];
    add(id, label, 'real', missing, 'Costs money. Daily quota (5 per day) and per-business budget still apply on top of the platform cap.');
  };
  paid('IMAGE');
  paid('VIDEO');

  const socialReal = env.SOCIAL_PROVIDER_MODE === 'live';
  add('social-publishing', 'Social network publishing', socialReal ? (env.SOCIAL_PUBLISHING_ENABLED ? 'real' : 'disabled') : 'simulated',
    socialReal && !env.SOCIAL_PUBLISHING_ENABLED ? ['SOCIAL_PUBLISHING_ENABLED=true'] : [],
    socialReal ? 'Platform app approvals and account consent are required per platform (see SOCIAL-PLATFORM-APPROVALS).' : 'Simulator: nothing is posted anywhere.');

  const billingReal = !['none', 'simulated'].includes(env.BILLING_PROVIDER);
  add('billing', 'Customer payments', billingReal ? 'real' : env.BILLING_PROVIDER === 'simulated' ? 'simulated' : 'disabled', billingReal && !env.BILLING_ENABLED ? ['BILLING_ENABLED=true'] : [], billingReal ? 'Real payment provider.' : 'No real payment can occur.');

  const s3 = env.STORAGE_DRIVER === 's3';
  add('storage', 'File storage', s3 ? 'real' : 'simulated', s3 ? ['S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'].filter((k) => !env[k as keyof AppEnv]) : ['persistent storage (STORAGE_DRIVER=s3)'], s3 ? 'Durable object storage.' : 'In memory: files are lost at every restart.');

  const smtp = env.EMAIL_TRANSPORT === 'smtp';
  add('email', 'E-mail delivery', smtp ? 'real' : 'simulated', smtp ? (env.SMTP_HOST ? [] : ['SMTP_HOST']) : ['EMAIL_TRANSPORT=smtp'], smtp ? 'Messages are sent.' : 'Messages are only written to the log.');

  add('environment', 'Environment', env.APP_ENV === 'production' ? 'real' : 'simulated', env.APP_ENV === 'production' ? [] : [`APP_ENV=production (now ${env.APP_ENV})`], 'Production refuses every test simulator at start-up.');

  // Only capabilities with an effect outside TOUMA (spending, publishing, charging) make a deployment "real"; storage, e-mail and the environment are infrastructure listed as blockers once it is.
  const EXTERNAL = ['ai-text', 'creative-images', 'creative-videos', 'social-publishing', 'billing'];
  const anyReal = caps.some((c) => c.mode === 'real' && EXTERNAL.includes(c.id));
  const blockers = caps.filter((c) => c.missing.length && (c.mode === 'real' || c.id === 'storage' || c.id === 'email' || c.id === 'environment')).flatMap((c) => c.missing.map((m) => `${c.label}: ${m}`));
  const overall = !anyReal ? 'SIMULATION' : blockers.length ? 'REAL_BLOCKED' : 'REAL_READY';
  return { overall, environment: env.APP_ENV, capabilities: caps, blockers };
}
