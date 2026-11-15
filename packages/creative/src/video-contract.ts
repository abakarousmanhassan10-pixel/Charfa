import { snapSeconds, type VideoProvider } from './types';

/**
 * Conformance check every VideoProvider must pass (simulators today, a real provider such as Higgsfield tomorrow). It only uses the public interface and returns the
 * list of problems (empty = conforming), so it works in unit tests and in a live-verification tool alike. A real provider is checked with a CAPPED budget: one short job.
 */
export async function checkVideoProvider(p: VideoProvider, opts: { maxPolls?: number; model?: string } = {}): Promise<string[]> {
  const problems: string[] = [];
  const need = (ok: boolean, msg: string) => { if (!ok) problems.push(msg); };
  need(!!p.name && /^[a-z0-9-]+$/.test(p.name), 'name must be a lowercase identifier');
  need(p.isConfigured(), 'isConfigured() must be true for a provider that is ready to run');
  const secs = p.capabilities.seconds;
  need(secs.length > 0 && secs.every((s, i) => i === 0 || s > secs[i - 1]!), 'capabilities.seconds must be ascending and not empty');
  const [ratio] = Object.keys(p.capabilities.sizes) as Array<keyof typeof p.capabilities.sizes>;
  const size = ratio ? p.capabilities.sizes[ratio] : undefined;
  need(!!size, 'capabilities.sizes must declare at least one size');
  if (problems.length || !size) return problems;
  const seconds = snapSeconds(p.capabilities, 8);
  const { ref } = await p.submit({ model: opts.model ?? 'contract-check', prompt: 'Contract check clip', seconds, size, timeoutMs: 10_000 });
  need(typeof ref === 'string' && ref.length > 0, 'submit() must return a non-empty ref');
  let state = 'queued';
  for (let i = 0; i < (opts.maxPolls ?? 20) && state !== 'completed' && state !== 'failed'; i++) {
    state = (await p.status(ref, 10_000)).state;
    if (state !== 'completed' && state !== 'failed') await new Promise((r) => setTimeout(r, 25));
  }
  need(state === 'completed', `the job must complete (last state: ${state})`);
  if (state === 'completed') {
    const f = await p.download(ref, 50 * 1024 * 1024, 10_000);
    need(f.mime.startsWith('video/'), 'download() must return a video mime type');
    need(f.data.length > 0, 'download() must return bytes');
  }
  return problems;
}
