import type { AspectRatio } from '@touma/shared';

/**
 * Provider adapter contracts for the Creative Studio. TOUMA talks only to these interfaces; each real
 * provider is one adapter that reads its credentials from configuration (never from code, never logged),
 * maps its failures to CreativeProviderError kinds, and declares what it can actually do (capabilities),
 * so the studio never offers - or pretends to deliver - something the configured provider cannot.
 */

export type CreativeErrorKind = 'auth' | 'billing' | 'rate_limit' | 'timeout' | 'server' | 'network' | 'bad_request' | 'refusal' | 'unsupported' | 'invalid_output';

export class CreativeProviderError extends Error {
  constructor(
    readonly kind: CreativeErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'CreativeProviderError';
  }
  /** Transient problems are retried by the queue; everything else is final. */
  get retryable() {
    return this.kind === 'rate_limit' || this.kind === 'timeout' || this.kind === 'server' || this.kind === 'network';
  }
}

export class CreativeNotConfiguredError extends Error {
  constructor(readonly kind: 'image' | 'video') {
    super(`${kind} generation is not configured on this server`);
    this.name = 'CreativeNotConfiguredError';
  }
}

export interface SourceImage {
  data: Buffer;
  mime: string;
  filename: string;
}

// ─── Images ───────────────────────────────────────────────────────────────────

export interface ImageCapabilities {
  /** Sizes the model renders natively. Anything else is produced by resizing. */
  nativeSizes: Array<{ width: number; height: number }>;
  maxImagesPerRequest: number;
  /** Can edit a supplied photo (needed for the "guided" preservation mode). */
  edit: boolean;
  /** Can be told to keep the input photo's details (higher fidelity edits). */
  inputFidelity: boolean;
}

export interface ImageGenerateRequest {
  model: string;
  prompt: string;
  count: number;
  /** Must be one of capabilities.nativeSizes (use nearestNativeSize). */
  size: { width: number; height: number };
  quality?: 'low' | 'medium' | 'high';
  /** Present for edits: the photo to edit. */
  source?: SourceImage;
  fidelity?: 'low' | 'high';
  timeoutMs: number;
}

export interface GeneratedImageData {
  data: Buffer;
  mime: string;
}

export interface ImageGenerateResult {
  images: GeneratedImageData[];
  model: string;
  /** Provider-reported token usage, where the provider reports it. */
  usage?: { inputTokens: number; outputTokens: number };
  revisedPrompt?: string;
}

export interface ImageProvider {
  readonly name: string;
  readonly capabilities: ImageCapabilities;
  isConfigured(): boolean;
  generate(req: ImageGenerateRequest): Promise<ImageGenerateResult>;
}

/** The native size whose aspect ratio is closest to the target (ties: the larger one). */
export function nearestNativeSize(caps: ImageCapabilities, target: { width: number; height: number }): { width: number; height: number } {
  const ratio = target.width / target.height;
  return [...caps.nativeSizes].sort((a, b) => Math.abs(a.width / a.height - ratio) - Math.abs(b.width / b.height - ratio) || b.width * b.height - a.width * a.height)[0]!;
}

// ─── Videos ───────────────────────────────────────────────────────────────────

export interface VideoCapabilities {
  /** Clip lengths the model can produce, ascending. */
  seconds: number[];
  sizes: Partial<Record<AspectRatio, { width: number; height: number }>>;
  imageToVideo: boolean;
  /** Provides a poster frame (TOUMA has no video decoder of its own). */
  thumbnail: boolean;
}

export interface VideoSubmitRequest {
  model: string;
  prompt: string;
  seconds: number;
  size: { width: number; height: number };
  source?: SourceImage;
  timeoutMs: number;
}

export type VideoState = 'queued' | 'in_progress' | 'completed' | 'failed';

export interface VideoStatus {
  state: VideoState;
  /** 0-100 when the provider reports it. */
  progress?: number;
  error?: { code: string; message: string };
}

export interface VideoProvider {
  readonly name: string;
  readonly capabilities: VideoCapabilities;
  isConfigured(): boolean;
  /** Starts the job and returns the provider's id for it. Called at most once per generation. */
  submit(req: VideoSubmitRequest): Promise<{ ref: string }>;
  status(ref: string, timeoutMs: number): Promise<VideoStatus>;
  download(ref: string, maxBytes: number, timeoutMs: number): Promise<{ data: Buffer; mime: string }>;
  thumbnail?(ref: string, timeoutMs: number): Promise<Buffer | null>;
}

/** The clip length to request and bill: the shortest supported length that covers the request, else the longest. */
export function snapSeconds(caps: VideoCapabilities, requested: number): number {
  return caps.seconds.find((s) => s >= requested) ?? caps.seconds[caps.seconds.length - 1]!;
}
