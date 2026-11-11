import type { Platform } from '@/components/calendar/types';

export type AccountStatus = 'CONNECTED' | 'TOKEN_EXPIRED' | 'PERMISSION_MISSING' | 'DISCONNECTED' | 'ERROR';
export type TokenState = 'NON_EXPIRING' | 'VALID' | 'EXPIRING' | 'EXPIRED';
export type PublicationStatus = 'PENDING' | 'QUEUED' | 'PUBLISHING' | 'AWAITING_PROVIDER' | 'PUBLISHED' | 'FAILED' | 'CANCELLED' | 'MANUAL_REQUIRED';

export interface SocialAccount {
  id: string;
  platform: Platform;
  externalAccountId: string;
  displayName: string | null;
  username: string | null;
  avatarUrl: string | null;
  accountType: string | null;
  status: AccountStatus;
  scopes: string[];
  permissionsMissing: string[];
  criticalPermissionsMissing: string[];
  tokenExpiresAt: string | null;
  tokenState: TokenState;
  canRefresh: boolean;
  connectedAt: string | null;
  lastError: string | null;
  lastRefreshError: string | null;
  tokenRefreshedAt: string | null;
}

export interface PlatformInfo {
  platform: Platform;
  label: string;
  configured: boolean;
  missingConfiguration: string[];
  requiredScopes: string[];
  supportsRefresh: boolean;
  redirectUri: string;
  mode: 'live' | 'fake';
  /** Separately configured ways of connecting (LinkedIn: personal profile, organization). */
  variants?: ConnectionVariantInfo[] | null;
  capabilities: {
    captionMax: number;
    hashtagsMax: number;
    supports: Record<'TEXT' | 'IMAGE' | 'CAROUSEL' | 'VIDEO', boolean>;
    mediaRequired: boolean;
    imageMimes: string[];
    videoMimes: string[];
    videoMaxSeconds: number;
    shortVideoMaxSeconds?: number;
    carouselMin: number;
    carouselMax: number;
    mediaByUrl: boolean;
  };
}

export interface ConnectionVariantInfo {
  id: string;
  accountType: string;
  enabled: boolean;
  configured: boolean;
  missingConfiguration: string[];
  scopes: string[];
  reason: string | null;
}

export interface SocialStatus {
  platforms: PlatformInfo[];
  publishing: { available: boolean };
  queue: { waiting: number; active: number; delayed: number; failed: number; completed: number } | null;
  inFlight: number;
}

export interface PendingConnection {
  id: string;
  platform: Platform;
  variant?: string | null;
  reconnectAccountId: string | null;
  candidates: Array<{
    externalAccountId: string;
    displayName: string | null;
    username: string | null;
    avatarUrl: string | null;
    accountType: string;
    permissionsMissing: string[];
    criticalPermissionsMissing: string[];
    alreadyConnected: boolean;
  }>;
}

export interface Publication {
  id: string;
  platform: Platform;
  status: PublicationStatus;
  mode: 'API' | 'MANUAL';
  scheduledAt: string;
  timezone: string;
  attempts: number;
  entryId: string | null;
  entryTitle: string | null;
  accountId: string;
  accountName: string | null;
  kind: string | null;
  errorCode: string | null;
  error: string | null;
  outcomeUnknown: boolean;
  visibilityNote?: string | null;
  reconcile?: { result: "FOUND" | "NOT_FOUND" | "AMBIGUOUS" | "UNAVAILABLE"; note: string | null; attempts: number; at: string | null; foundOnPlatform: boolean } | null;
  confirmedByProvider: boolean;
  externalPostId: string | null;
  externalUrl: string | null;
  publishedAt: string | null;
  nextCheckAt: string | null;
  createdAt: string;
  manualPackage?: { text: string; media: Array<{ id: string; filename: string; mimeType: string; downloadUrl: string }> };
}

export interface QueueResponse {
  queue: { waiting: number; active: number; delayed: number; failed: number; completed: number } | null;
  inFlight: number;
  byStatus: Record<string, number>;
  upcoming: Array<{ id: string; title: string; platform: Platform; scheduledAt: string; timezone: string; accountId: string | null }>;
  items: Publication[];
}

export interface PublicationAnalytics {
  publicationId: string;
  platform: Platform;
  measurable: boolean;
  reason: 'NOT_PUBLISHED' | 'MANUAL_PUBLICATION' | null;
  snapshot: {
    fetchedAt: string;
    metrics: Record<'views' | 'reach' | 'impressions' | 'likes' | 'comments' | 'shares' | 'saves' | 'linkClicks', number | null>;
    engagementRate: number | null;
    unavailableReason: string | null;
  } | null;
}
