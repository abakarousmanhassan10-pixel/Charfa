import type { MediaItem } from '@/components/media/media-types';

export interface CreativeOutput {
  id: string;
  index: number;
  width: number | null;
  height: number | null;
  preservation: 'EXACT' | 'GUIDED' | 'NONE' | null;
  upscaled: boolean;
  selected: boolean;
  revisedPrompt: string | null;
  media: MediaItem;
}

export interface CreativeGeneration {
  id: string;
  kind: 'IMAGE' | 'VIDEO';
  status: 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED';
  retrying: boolean;
  provider: string;
  model: string;
  prompt: string;
  params: Record<string, unknown>;
  itemType: string | null;
  itemId: string | null;
  sourceMediaId: string | null;
  parentId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  usage: { requestedUnits: number; producedUnits: number; unitKind: 'IMAGE' | 'VIDEO_SECOND'; inputTokens: number; outputTokens: number; costUsd: number; costKnown: boolean; processingMs: number };
  job: { attempts: number; pollCount: number; providerStatus: string | null; queuedAt: string | null; startedAt: string | null; completedAt: string | null };
  outputs: CreativeOutput[];
  createdAt: string;
  replayed?: boolean;
}

export interface CreativeJobStatus {
  id: string;
  kind: 'IMAGE' | 'VIDEO';
  status: CreativeGeneration['status'];
  retrying: boolean;
  final: boolean;
  attempt: number;
  maxAttempts: number;
  providerStatus: string | null;
  pollCount: number;
  errorCode: string | null;
  errorMessage: string | null;
  producedUnits: number;
  requestedUnits: number;
}

export interface Meter {
  completed: number;
  reserved: number;
  limit: number;
  remaining: number;
}

export interface CreativeOverview {
  image: { configured: boolean; provider: string; model: string; capabilities: { nativeSizes: Array<{ width: number; height: number }>; maxImagesPerRequest: number; edit: boolean; inputFidelity: boolean } | null };
  video: { configured: boolean; provider: string; model: string; capabilities: { seconds: number[]; aspectRatios: string[]; imageToVideo: boolean; thumbnail: boolean } | null };
  storyboard: { configured: boolean };
  storage: { configured: boolean; usedBytes: number; quotaBytes: number; files: number };
  usage: { images: Meter; videoSeconds: Meter; limitSource: 'plan' | 'default'; periodStart: string };
  costTracking: boolean;
  options: {
    imageTypes: string[]; styles: string[]; backgrounds: string[]; themes: string[]; aspectRatios: string[]; resolutions: Record<string, number>; overlayPositions: string[]; logoPlacements: string[];
    preservationModes: string[]; platforms: string[]; platformAspects: Record<string, string[]>;
    videoFormats: Record<string, { aspect: string; label: string; platforms: string[]; minSeconds: number; maxSeconds: number }>; videoStyles: string[]; fonts: string[];
    limits: { maxImagesPerRequest: number; maxOverlayChars: number; maxGuidelinesChars: number; maxInstructionChars: number; maxColors: number };
  };
}

export interface BrandColor {
  name: string;
  hex: string;
  role: string;
}

export interface BrandKit {
  configured: boolean;
  colors: BrandColor[];
  headingFont: string | null;
  bodyFont: string | null;
  visualStyle: string | null;
  guidelines: string | null;
  preferredTone: string | null;
  logo: MediaItem | null;
  updatedAt: string | null;
}

export interface Storyboard {
  language: string;
  format: string;
  aspectRatio: string;
  totalSeconds: number;
  title: string;
  concept: string;
  hook: string;
  voiceoverScript: string | null;
  scenes: Array<{ order: number; durationSeconds: number; visual: string; camera: string | null; voiceover: string | null; onScreenText: string | null; audio: string | null; productFocus: string | null }>;
  callToAction: string;
  musicMood: string | null;
  hashtags: string[];
  videoPrompt: string;
  claims: Array<{ claim: string; source: string }>;
  warnings: string[];
  missingInformation: string[];
}
