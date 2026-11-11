import { mapOpenAIError, timedFetch } from './http';
import { CreativeNotConfiguredError, CreativeProviderError, type ImageCapabilities, type ImageGenerateRequest, type ImageGenerateResult, type ImageProvider } from './types';

export interface OpenAIImageConfig {
  apiKey?: string;
  baseUrl?: string;
  organization?: string;
}

/**
 * OpenAI Images adapter (gpt-image-1 style): POST /images/generations for new images and POST /images/edits for
 * edits of a supplied photo. Credentials come from configuration only.
 *
 * NOTE: written against the documented API and checked with a stubbed fetch in unit tests. It has NOT been run
 * against the real service from this repository; do that with a development key before relying on it.
 */
export class OpenAIImageProvider implements ImageProvider {
  readonly name = 'openai';
  readonly capabilities: ImageCapabilities = {
    nativeSizes: [
      { width: 1024, height: 1024 },
      { width: 1536, height: 1024 },
      { width: 1024, height: 1536 },
    ],
    maxImagesPerRequest: 4,
    edit: true,
    inputFidelity: true,
  };
  private readonly base: string;

  constructor(private readonly cfg: OpenAIImageConfig) {
    this.base = (cfg.baseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '');
  }

  isConfigured() {
    return Boolean(this.cfg.apiKey);
  }

  private headers(): Record<string, string> {
    if (!this.cfg.apiKey) throw new CreativeNotConfiguredError('image');
    return { authorization: `Bearer ${this.cfg.apiKey}`, ...(this.cfg.organization ? { 'openai-organization': this.cfg.organization } : {}) };
  }

  async generate(req: ImageGenerateRequest): Promise<ImageGenerateResult> {
    const size = `${req.size.width}x${req.size.height}`;
    let res: Response;
    if (req.source) {
      const form = new FormData();
      form.set('model', req.model);
      form.set('prompt', req.prompt);
      form.set('n', String(req.count));
      form.set('size', size);
      if (req.quality) form.set('quality', req.quality);
      if (req.fidelity) form.set('input_fidelity', req.fidelity);
      form.set('image', new Blob([new Uint8Array(req.source.data)], { type: req.source.mime }), req.source.filename);
      res = await timedFetch(`${this.base}/images/edits`, { method: 'POST', headers: this.headers(), body: form }, req.timeoutMs, 'OpenAI Images');
    } else {
      res = await timedFetch(
        `${this.base}/images/generations`,
        { method: 'POST', headers: { ...this.headers(), 'content-type': 'application/json' }, body: JSON.stringify({ model: req.model, prompt: req.prompt, n: req.count, size, ...(req.quality ? { quality: req.quality } : {}) }) },
        req.timeoutMs,
        'OpenAI Images',
      );
    }
    if (!res.ok) throw await mapOpenAIError(res, 'OpenAI Images');
    const body = (await res.json()) as { data?: Array<{ b64_json?: string; revised_prompt?: string }>; usage?: { input_tokens?: number; output_tokens?: number } };
    const items = body.data ?? [];
    const images = items.filter((i) => i.b64_json).map((i) => ({ data: Buffer.from(i.b64_json!, 'base64'), mime: 'image/png' }));
    if (images.length === 0) throw new CreativeProviderError('invalid_output', 'OpenAI Images returned no image');
    return {
      images,
      model: req.model,
      usage: body.usage ? { inputTokens: body.usage.input_tokens ?? 0, outputTokens: body.usage.output_tokens ?? 0 } : undefined,
      revisedPrompt: items[0]?.revised_prompt,
    };
  }
}
