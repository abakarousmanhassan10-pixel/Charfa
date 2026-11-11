import type { ContentPillar, EntryStatus, TimeSource } from '@touma/shared';

export type Platform = 'INSTAGRAM' | 'FACEBOOK' | 'TIKTOK' | 'YOUTUBE' | 'LINKEDIN';
export const PLATFORMS: Platform[] = ['INSTAGRAM', 'FACEBOOK', 'TIKTOK', 'YOUTUBE', 'LINKEDIN'];
/** The platforms TOUMA AI can plan content for (LinkedIn entries are created by hand). */
export const AI_PLATFORM_LIST: Platform[] = ['INSTAGRAM', 'FACEBOOK', 'TIKTOK', 'YOUTUBE'];

export interface Conflict {
  code: string;
  severity: 'hard' | 'soft' | string;
  message: string;
  withEntryId?: string;
  withTitle?: string;
}

export interface Entry {
  id: string;
  title: string;
  brief: string | null;
  notes: string | null;
  platform: Platform | null;
  pillar: ContentPillar | null;
  occasion: string | null;
  status: EntryStatus;
  scheduledAt: string;
  timezone: string;
  local: { date: string; time: string };
  timeSource: TimeSource;
  timeNote: string | null;
  planId: string | null;
  recurrenceId: string | null;
  socialAccountId: string | null;
  authorizedAt: string | null;
  authorizedById: string | null;
  dispatchState: string;
  dispatchAttempts: number;
  lastError: string | null;
  content: {
    id: string;
    type: 'TEXT' | 'IMAGE' | 'VIDEO' | 'CAROUSEL';
    caption: string | null;
    hashtags: string[];
    callToAction: string | null;
    language: string;
    origin: 'HUMAN' | 'AI_GENERATED' | 'AI_ASSISTED';
    version: number;
    approvedVersion: number | null;
    rejectionReason: string | null;
    mediaIds: string[];
    platformOptions?: { tiktok?: Record<string, unknown> } | null;
  } | null;
  conflicts: Conflict[];
}

export interface RangeResponse {
  timezone: string;
  from: string;
  to: string;
  items: Entry[];
  conflicts: Array<{ entryId: string; code: string; message: string; withEntryId?: string }>;
}

export interface Overview {
  timezone: string;
  today: string;
  language: string;
  counts: { byStatus: Record<string, number>; byPillar: Record<string, number>; total: number };
  pendingApprovals: number;
  failed: number;
  conflicts: number;
  upcoming: Entry[];
  connectedPlatforms: Platform[];
  publishing: { available: boolean };
}

export interface Recommendation {
  platform: Platform;
  date: string;
  timezone: string;
  source: 'ANALYTICS' | 'ESTIMATE';
  sampleSize: number;
  note: string;
  slots: Array<{ time: string; scheduledAt: string; reason: string }>;
}

export interface PlanPreview {
  generationId: string;
  appliedPlanId: string | null;
  timezone: string;
  plan: { language: string; startDate: string; days: number; summary: string; warnings: string[]; missingInformation: string[] };
  balance: Record<string, number>;
  items: Array<{
    index: number;
    day: number;
    platform: Platform;
    pillar: ContentPillar;
    contentType: string;
    title: string;
    brief: string;
    occasion: string | null;
    itemId: string | null;
    proposed?: { date: string; scheduledAt: string | null; source: TimeSource; note: string | null };
  }>;
}

export interface ApprovalsResponse {
  timezone: string;
  view: 'pending' | 'decided';
  pendingCount: number;
  total: number;
  items: Array<Entry & { decision?: string }>;
}

export interface DecidedRecord {
  id: string;
  decision: string;
  version: number;
  note: string | null;
  actorName: string | null;
  createdAt: string;
  entry: { id: string; title: string; platform: Platform | null; scheduledAt: string } | null;
}

export interface HistoryRecord {
  id: string;
  decision: string;
  version: number;
  note: string | null;
  actorName: string | null;
  createdAt: string;
}

export interface Recurrence {
  id: string;
  title: string;
  platform: Platform;
  pillar: ContentPillar | null;
  frequency: 'DAILY' | 'WEEKLY';
  weekdays: number[];
  localTime: string;
  timezone: string;
  startDate: string;
  endDate: string;
  entries: number;
}

export interface NotificationItem {
  id: string;
  type: string;
  title: string;
  body: string | null;
  data: Record<string, unknown> | null;
  readAt: string | null;
  createdAt: string;
}
