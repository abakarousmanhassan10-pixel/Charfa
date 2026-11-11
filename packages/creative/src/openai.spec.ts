import { CreativeNotConfiguredError, CreativeProviderError } from './types';
import { OpenAIImageProvider } from './openai-image';
import { OpenAIVideoProvider } from './openai-video';
import { fakeMp4 } from './testing/fake';

const png = Buffer.from('89504e470d0a1a0a', 'hex');
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const KEY = 'sk-test-0123456789abcdef0123456789';
let calls: Array<{ url: string; init: RequestInit }>;
const stub = (...responses: Array<Response | Error>) => {
  calls = [];
  const queue = [...responses];
  jest.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = queue.shift()!;
    if (next instanceof Error) throw next;
    return next;
  });
};
afterEach(() => jest.restoreAllMocks());

const req = { model: 'gpt-image-1', prompt: 'A scene', count: 2, size: { width: 1024, height: 1024 }, timeoutMs: 5000 };
const images = new OpenAIImageProvider({ apiKey: KEY });

describe('OpenAI image adapter (stubbed network)', () => {
  it('generates images: JSON request, bearer key, base64 results and token usage', async () => {
    stub(json({ data: [{ b64_json: png.toString('base64'), revised_prompt: 'revised' }, { b64_json: png.toString('base64') }], usage: { input_tokens: 50, output_tokens: 4000 } }));
    const r = await images.generate({ ...req, quality: 'high' });
    expect(calls[0]!.url).toBe('https://api.openai.com/v1/images/generations');
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ model: 'gpt-image-1', prompt: 'A scene', n: 2, size: '1024x1024', quality: 'high' });
    expect(r.images).toHaveLength(2);
    expect(r.images[0]!.data.equals(png)).toBe(true);
    expect(r.usage).toEqual({ inputTokens: 50, outputTokens: 4000 });
    expect(r.revisedPrompt).toBe('revised');
  });

  it('edits a supplied photo with multipart upload and input fidelity', async () => {
    stub(json({ data: [{ b64_json: png.toString('base64') }] }));
    await images.generate({ ...req, count: 1, source: { data: Buffer.from('photo'), mime: 'image/png', filename: 'p.png' }, fidelity: 'high' });
    expect(calls[0]!.url).toBe('https://api.openai.com/v1/images/edits');
    const form = calls[0]!.init.body as FormData;
    expect(form.get('model')).toBe('gpt-image-1');
    expect(form.get('input_fidelity')).toBe('high');
    expect(form.get('n')).toBe('1');
    expect(form.get('image')).toBeInstanceOf(Blob);
  });

  it('honours a custom base URL and organization header', async () => {
    stub(json({ data: [{ b64_json: png.toString('base64') }] }));
    await new OpenAIImageProvider({ apiKey: KEY, baseUrl: 'https://gateway.example/v1/', organization: 'org_1' }).generate(req);
    expect(calls[0]!.url).toBe('https://gateway.example/v1/images/generations');
    expect((calls[0]!.init.headers as Record<string, string>)['openai-organization']).toBe('org_1');
  });

  it.each([
    [401, {}, 'auth', false],
    [403, { error: { message: 'Your organization must be verified' } }, 'auth', false],
    [429, { error: { code: 'rate_limit_exceeded' } }, 'rate_limit', true],
    [429, { error: { code: 'insufficient_quota', message: 'You exceeded your current quota' } }, 'billing', false],
    [500, {}, 'server', true],
    [503, {}, 'server', true],
    [400, { error: { code: 'moderation_blocked', message: 'Your request was rejected by the safety system' } }, 'refusal', false],
    [400, { error: { message: 'Invalid size' } }, 'bad_request', false],
  ])('maps HTTP %s to %s (retryable: %s)', async (status, body, kind, retryable) => {
    stub(json(body, status as number));
    const err = await images.generate(req).catch((e) => e);
    expect(err).toBeInstanceOf(CreativeProviderError);
    expect(err).toMatchObject({ kind, retryable });
  });

  it('maps network failures and timeouts to retryable errors, and never leaks the key or the prompt', async () => {
    stub(new TypeError('fetch failed: ' + KEY));
    const net = await images.generate({ ...req, prompt: 'SECRET PROMPT' }).catch((e) => e);
    expect(net).toMatchObject({ kind: 'network', retryable: true });
    expect(net.message).not.toContain(KEY);
    expect(net.message).not.toContain('SECRET PROMPT');
    jest.restoreAllMocks();
    jest.spyOn(global, 'fetch').mockImplementation((_u, init) => new Promise((_res, rej) => (init!.signal as AbortSignal).addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })))));
    expect(await images.generate({ ...req, timeoutMs: 20 }).catch((e) => e)).toMatchObject({ kind: 'timeout', retryable: true });
    stub(json({ error: { message: `bad key ${KEY}` } }, 400));
    expect((await images.generate(req).catch((e) => e)).message).not.toContain(KEY);
  });

  it('rejects an answer with no image, and refuses to run without a key', async () => {
    stub(json({ data: [] }));
    expect(await images.generate(req).catch((e) => e)).toMatchObject({ kind: 'invalid_output' });
    const none = new OpenAIImageProvider({});
    expect(none.isConfigured()).toBe(false);
    await expect(none.generate(req)).rejects.toBeInstanceOf(CreativeNotConfiguredError);
  });
});

describe('OpenAI video adapter (stubbed network)', () => {
  const video = new OpenAIVideoProvider({ apiKey: KEY });
  const sub = { model: 'sora-2', prompt: 'A drink', seconds: 8, size: { width: 720, height: 1280 }, timeoutMs: 5000 };

  it('submits a job once and returns its id; sends the reference image when given', async () => {
    stub(json({ id: 'video_123', status: 'queued' }), json({ id: 'video_456' }));
    expect(await video.submit(sub)).toEqual({ ref: 'video_123' });
    const form = calls[0]!.init.body as FormData;
    expect(calls[0]!.url).toBe('https://api.openai.com/v1/videos');
    expect([form.get('model'), form.get('seconds'), form.get('size')]).toEqual(['sora-2', '8', '720x1280']);
    expect(form.get('input_reference')).toBeNull();
    await video.submit({ ...sub, source: { data: Buffer.from('x'), mime: 'image/png', filename: 'p.png' } });
    expect((calls[1]!.init.body as FormData).get('input_reference')).toBeInstanceOf(Blob);
  });

  it('reports status, progress and failures', async () => {
    stub(json({ status: 'queued' }), json({ status: 'in_progress', progress: 40 }), json({ status: 'completed', progress: 100 }), json({ status: 'failed', error: { code: 'moderation', message: 'Declined' } }));
    expect((await video.status('v', 1000)).state).toBe('queued');
    expect(await video.status('v', 1000)).toMatchObject({ state: 'in_progress', progress: 40 });
    expect((await video.status('v', 1000)).state).toBe('completed');
    expect(await video.status('v', 1000)).toMatchObject({ state: 'failed', error: { code: 'moderation', message: 'Declined' } });
    expect(calls[0]!.url).toBe('https://api.openai.com/v1/videos/v');
  });

  it('downloads the file within the size cap, and fetches the poster frame', async () => {
    stub(new Response(fakeMp4(), { headers: { 'content-type': 'video/mp4' } }), new Response(fakeMp4(), { headers: { 'content-type': 'video/mp4', 'content-length': '999999999' } }), new Response(png), new Response('no', { status: 404 }));
    const ok = await video.download('v', 10_000_000, 1000);
    expect(ok.mime).toBe('video/mp4');
    expect(ok.data.equals(fakeMp4())).toBe(true);
    expect(await video.download('v', 1000, 1000).catch((e) => e)).toMatchObject({ kind: 'invalid_output' });
    expect((await video.thumbnail!('v', 1000))!.equals(png)).toBe(true);
    expect(calls[2]!.url).toBe('https://api.openai.com/v1/videos/v/content?variant=thumbnail');
    expect(await video.thumbnail!('v', 1000)).toBeNull();
  });

  it('maps errors like the image adapter and needs a key', async () => {
    stub(json({}, 429));
    expect(await video.submit(sub).catch((e) => e)).toMatchObject({ kind: 'rate_limit', retryable: true });
    expect(new OpenAIVideoProvider({}).isConfigured()).toBe(false);
    await expect(new OpenAIVideoProvider({}).submit(sub)).rejects.toBeInstanceOf(CreativeNotConfiguredError);
  });
});
