import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import sharp from 'sharp';
import { CreativeProviderError, type VideoCapabilities, type VideoProvider, type VideoStatus, type VideoSubmitRequest } from './types';

/**
 * FREE TEST MODE (CREATIVE_STUDIO_MODE=mock). Local demo files and templates only: no network, no API, no cost. Everything these classes return is labelled
 * "simulated" and must never be shown as a real AI generation.
 */

const SIZES = { '9:16': { width: 360, height: 640, file: '9x16' }, '16:9': { width: 640, height: 360, file: '16x9' }, '1:1': { width: 480, height: 480, file: '1x1' }, '4:5': { width: 432, height: 540, file: '4x5' } } as const;
const assetPath = (file: string) => [join(__dirname, '..', 'assets', file), join(__dirname, '..', '..', 'assets', file), join(__dirname, '..', '..', '..', 'assets', file)].find((p) => existsSync(p));

/** Reference duration of a demo video, in seconds. */
export const MOCK_VIDEO_SECONDS = 8;

/** Plays back the pre-generated local demo clips (8 seconds, one per format). The prompt and any photo are ignored: it is a placeholder, not a model. */
export class MockVideoProvider implements VideoProvider {
  readonly name: string = 'mock';
  readonly capabilities: VideoCapabilities = {
    seconds: [MOCK_VIDEO_SECONDS],
    sizes: Object.fromEntries(Object.entries(SIZES).map(([k, v]) => [k, { width: v.width, height: v.height }])) as VideoCapabilities['sizes'],
    imageToVideo: true,
    thumbnail: true,
  };
  readonly submits: VideoSubmitRequest[] = [];
  private counter = 0;
  private readonly files = new Map<string, string>();
  isConfigured() { return true; }
  async submit(req: VideoSubmitRequest) {
    // A request containing simulate-failure simulates a provider failure (nothing is produced, nothing is counted).
    if (/simulate-failure/i.test(req.prompt)) throw new CreativeProviderError('bad_request', 'Simulated provider failure', 400);
    this.submits.push(req);
    const match = Object.values(SIZES).find((s) => s.width === req.size.width && s.height === req.size.height) ?? SIZES['9:16'];
    const ref = `mockvid_${++this.counter}`;
    this.files.set(ref, match.file);
    return { ref };
  }
  async status(): Promise<VideoStatus> { return { state: 'completed', progress: 100 }; }
  async download(ref: string) {
    const file = this.files.get(ref) ?? '9x16';
    const path = assetPath(`demo-video-${file}.mp4`);
    if (!path) throw new CreativeProviderError('server', 'The local demo video is missing from the package', 500);
    return { data: readFileSync(path), mime: 'video/mp4' };
  }
  async thumbnail(ref: string): Promise<Buffer | null> {
    const f = this.files.get(ref) ?? '9x16';
    const size = Object.values(SIZES).find((s) => s.file === f)!;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size.width}" height="${size.height}"><rect width="100%" height="100%" fill="#1f3a4d"/><text x="50%" y="50%" font-size="${Math.round(size.height * 0.05)}" font-family="sans-serif" fill="#ffffff" text-anchor="middle">SIMULATED DEMO VIDEO</text></svg>`;
    return sharp(Buffer.from(svg)).png().toBuffer();
  }
}

// ─── Script provider ─────────────────────────────────────────────────────────

export interface ScriptRequest { brief: string; language: 'en' | 'fr' | 'tr' | 'ar'; seconds: number; style: string; brandName?: string | null }
export interface ScriptScene { order: number; seconds: number; visual: string; voiceover: string }
export interface ScriptResult { hook: string; scenes: ScriptScene[]; caption: string; hashtags: string[]; simulated: boolean; disclaimer: string }
export interface ScriptProvider { readonly name: string; isConfigured(): boolean; generate(req: ScriptRequest): Promise<ScriptResult> }

const WORDS = /[\p{L}\p{N}'-]+/gu;
const T = {
  en: { hook: (b: string) => `Meet ${b}.`, open: 'Opening shot', mid: 'Close-up', end: 'Closing shot', vo: (b: string) => `${b}`, cta: 'Ask us for details.', disc: 'Simulated script template: no AI model was used and no claim was verified.' },
  fr: { hook: (b: string) => `Découvrez ${b}.`, open: 'Plan d\'ouverture', mid: 'Gros plan', end: 'Plan final', vo: (b: string) => `${b}`, cta: 'Demandez-nous les détails.', disc: 'Modèle de script simulé : aucun modèle IA utilisé, aucune affirmation vérifiée.' },
} as const;

/** Deterministic script from a template. It reuses only the client's own words (nothing about the product is invented) and says plainly that it is simulated. */
export class MockScriptProvider implements ScriptProvider {
  readonly name = 'mock';
  isConfigured() { return true; }
  async generate(req: ScriptRequest): Promise<ScriptResult> {
    const t = req.language === 'fr' ? T.fr : T.en;
    const brief = req.brief.replace(/\s+/g, ' ').trim().slice(0, 160);
    const subject = req.brandName?.trim() || brief.split(/[.!?]/)[0]!.slice(0, 60);
    const third = Math.max(1, Math.round(req.seconds / 3));
    const scenes: ScriptScene[] = [
      { order: 1, seconds: third, visual: `${t.open}: ${brief}`, voiceover: t.hook(subject) },
      { order: 2, seconds: third, visual: `${t.mid}: ${brief}`, voiceover: t.vo(brief) },
      { order: 3, seconds: Math.max(1, req.seconds - 2 * third), visual: `${t.end} (${req.style.toLowerCase()})`, voiceover: t.cta },
    ];
    const tags = [...new Set((brief.match(WORDS) ?? []).filter((w) => w.length > 4).slice(0, 3).map((w) => `#${w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')}`))];
    return { hook: t.hook(subject), scenes, caption: `${t.hook(subject)} ${brief}${brief.endsWith('.') ? '' : '.'} ${t.cta}`.slice(0, 600), hashtags: tags, simulated: true, disclaimer: t.disc };
  }
}

// ─── Higgsfield placeholder (disabled) ───────────────────────────────────────

/**
 * Placeholder for the future Higgsfield video provider. It is NOT connected: it never reads a key, never opens a connection and refuses every call. Enabling it needs
 * the verified API contract, models, parameters, prices and an approved generation budget (see docs/CREATIVE-MOCK.md).
 */
export class HiggsfieldProvider implements VideoProvider {
  readonly name = 'higgsfield';
  readonly capabilities: VideoCapabilities = { seconds: [], sizes: {}, imageToVideo: false, thumbnail: false };
  isConfigured() { return false; }
  private refuse(): never { throw new CreativeProviderError('unsupported', 'The Higgsfield provider is disabled in this build', 501); }
  async submit(): Promise<{ ref: string }> { return this.refuse(); }
  async status(): Promise<VideoStatus> { return this.refuse(); }
  async download(): Promise<{ data: Buffer; mime: string }> { return this.refuse(); }
}
