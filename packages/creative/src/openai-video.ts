import { mapOpenAIError, timedFetch } from './http';
import { CreativeNotConfiguredError, CreativeProviderError, type VideoCapabilities, type VideoProvider, type VideoStatus, type VideoSubmitRequest } from './types';
import type { OpenAIImageConfig } from './openai-image';

/**
 * OpenAI video adapter (Sora API shape): POST /videos starts an asynchronous job, GET /videos/{id} reports its
 * status, GET /videos/{id}/content returns the file (and ?variant=thumbnail a poster image).
 *
 * NOTE: written against the documented API and checked with a stubbed fetch in unit tests. It has NOT been run
 * against the real service from this repository. Video access, model names and clip lengths depend on your
 * OpenAI account; verify with a development key first.
 */
export class OpenAIVideoProvider implements VideoProvider {
  readonly name = 'openai';
  readonly capabilities: VideoCapabilities = {
    seconds: [4, 8, 12],
    sizes: { '9:16': { width: 720, height: 1280 }, '16:9': { width: 1280, height: 720 } },
    imageToVideo: true,
    thumbnail: true,
  };
  private readonly base: string;

  constructor(private readonly cfg: OpenAIImageConfig) {
    this.base = (cfg.baseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '');
  }

  isConfigured() {
    return Boolean(this.cfg.apiKey);
  }

  private headers(): Record<string, string> {
    if (!this.cfg.apiKey) throw new CreativeNotConfiguredError('video');
    return { authorization: `Bearer ${this.cfg.apiKey}`, ...(this.cfg.organization ? { 'openai-organization': this.cfg.organization } : {}) };
  }

  async submit(req: VideoSubmitRequest): Promise<{ ref: string }> {
    const form = new FormData();
    form.set('model', req.model);
    form.set('prompt', req.prompt);
    form.set('seconds', String(req.seconds));
    form.set('size', `${req.size.width}x${req.size.height}`);
    if (req.source) form.set('input_reference', new Blob([new Uint8Array(req.source.data)], { type: req.source.mime }), req.source.filename);
    const res = await timedFetch(`${this.base}/videos`, { method: 'POST', headers: this.headers(), body: form }, req.timeoutMs, 'OpenAI Video');
    if (!res.ok) throw await mapOpenAIError(res, 'OpenAI Video');
    const body = (await res.json()) as { id?: string };
    if (!body.id) throw new CreativeProviderError('invalid_output', 'OpenAI Video did not return a job id');
    return { ref: body.id };
  }

  async status(ref: string, timeoutMs: number): Promise<VideoStatus> {
    const res = await timedFetch(`${this.base}/videos/${encodeURIComponent(ref)}`, { headers: this.headers() }, timeoutMs, 'OpenAI Video');
    if (!res.ok) throw await mapOpenAIError(res, 'OpenAI Video');
    const body = (await res.json()) as { status?: string; progress?: number; error?: { code?: string; message?: string } | null };
    const state = body.status === 'completed' ? 'completed' : body.status === 'failed' ? 'failed' : body.status === 'queued' ? 'queued' : 'in_progress';
    return { state, progress: body.progress, ...(body.error ? { error: { code: body.error.code ?? 'failed', message: (body.error.message ?? 'The video could not be generated').slice(0, 300) } } : {}) };
  }

  async download(ref: string, maxBytes: number, timeoutMs: number) {
    const res = await timedFetch(`${this.base}/videos/${encodeURIComponent(ref)}/content`, { headers: this.headers() }, timeoutMs, 'OpenAI Video');
    if (!res.ok) throw await mapOpenAIError(res, 'OpenAI Video');
    const declared = Number(res.headers.get('content-length') ?? 0);
    if (declared > maxBytes) throw new CreativeProviderError('invalid_output', 'The generated video is larger than the allowed size');
    const data = Buffer.from(await res.arrayBuffer());
    if (data.length > maxBytes) throw new CreativeProviderError('invalid_output', 'The generated video is larger than the allowed size');
    return { data, mime: res.headers.get('content-type')?.split(';')[0] ?? 'video/mp4' };
  }

  async thumbnail(ref: string, timeoutMs: number): Promise<Buffer | null> {
    const res = await timedFetch(`${this.base}/videos/${encodeURIComponent(ref)}/content?variant=thumbnail`, { headers: this.headers() }, timeoutMs, 'OpenAI Video').catch(() => null);
    if (!res || !res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  }
}
