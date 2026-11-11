export interface StepReport {
  step: string;
  status: 'done' | 'reused' | 'skipped';
  generationId?: string;
  detail?: string;
}

// The output shape depends on the AI task; callers narrow it with the type parameter.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface Generation<T = any> {
  id: string;
  task: 'BUSINESS_ANALYSIS' | 'PRODUCT_ANALYSIS' | 'MARKETING_STRATEGY' | 'CONTENT';
  status: 'SUCCEEDED' | 'FAILED' | 'BLOCKED';
  itemType: string | null;
  itemId: string | null;
  platform: string | null;
  format: string | null;
  language: string;
  tone: string | null;
  purpose: string | null;
  instructions: string | null;
  output: T | null;
  originalOutput: T | null;
  edited: boolean;
  errorCode: string | null;
  errorMessage: string | null;
  model: string;
  promptVersion: string;
  injectionFlags: string[];
  usage: { inputTokens: number; outputTokens: number; costUsd: number; latencyMs: number; attempts: number };
  parentId: string | null;
  contentId: string | null;
  createdAt: string;
  steps?: StepReport[];
}

export interface AiStatus {
  configured: boolean;
  provider: string;
  model: string;
  temperature: number | string;
  maxOutputTokens: number;
  costTracking: boolean;
  usage: { generations: number; tokens: number; generationLimit: number; tokenLimit: number; periodStart: string };
  options: { formatsByPlatform: Record<string, string[]>; formatRules: Record<string, FormatRule> };
}

export interface FormatRule {
  platform: string | null;
  requires: string[];
  maxCaptionChars: number;
  maxTitleChars?: number;
  maxDescriptionChars?: number;
  maxHashtags: number;
  slides?: { min: number; max: number };
  storyFrames?: { min: number; max: number };
  durationSeconds?: { min: number; max: number };
}

export interface ContentOutput {
  language: string;
  format: string;
  platform: string | null;
  title: string | null;
  hook: string | null;
  caption: string | null;
  description: string | null;
  slides: Array<{ heading: string; body: string }>;
  scenes: Array<{ order: number; durationSeconds: number; visual: string; voiceover: string | null; onScreenText: string | null }>;
  storyFrames: Array<{ text: string; visualIdea: string; interactiveElement: string | null }>;
  hashtags: string[];
  callToAction: string;
  visualSuggestions: string[];
  claims: Array<{ claim: string; source: string }>;
  warnings: string[];
}
