import { Injectable } from '@nestjs/common';
import type { SocialPlatform } from '@touma/database';

/**
 * The publishing interface the calendar hands due entries to. The calendar NEVER publishes anything itself.
 *
 * Phase 6 implements this (Instagram, Facebook, TikTok, YouTube) and provides it under PUBLISHING_GATEWAY. Contract:
 *  - `submit` must be idempotent on `idempotencyKey`: the same key is sent again after a worker crash or a retry, and
 *    must never produce a second post.
 *  - ACCEPTED means the publisher took responsibility for the entry. The final outcome is reported later through
 *    CalendarDispatchService.recordPublished / recordFailed. "Published" may only be reported from a provider response.
 *  - REJECTED with retryable=true is retried by the queue with backoff; otherwise the entry becomes FAILED.
 */
export interface PublishingRequest {
  idempotencyKey: string;
  businessId: string;
  entryId: string;
  contentId: string;
  contentVersion: number;
  platform: SocialPlatform;
  scheduledAt: Date;
  timezone: string;
  caption: string | null;
  hashtags: string[];
  callToAction: string | null;
  mediaIds: string[];
  /** The person who explicitly authorized this publication, and when. */
  authorizedById: string;
  authorizedAt: Date;
}

export type PublishingOutcome = { status: 'ACCEPTED'; reference?: string } | { status: 'REJECTED'; code: string; message: string; retryable: boolean };

export interface PublishingGateway {
  readonly name: string;
  /** False when no publisher is connected: due entries wait (BLOCKED) instead of failing. */
  isAvailable(): boolean | Promise<boolean>;
  submit(request: PublishingRequest): Promise<PublishingOutcome>;
}

export const PUBLISHING_GATEWAY = Symbol('PUBLISHING_GATEWAY');

/** Phase 5 default: there is no publisher yet, so nothing is ever published and due entries are reported as waiting. */
@Injectable()
export class UnavailablePublishingGateway implements PublishingGateway {
  readonly name = 'none';
  isAvailable() {
    return false;
  }
  async submit(): Promise<PublishingOutcome> {
    return { status: 'REJECTED', code: 'PUBLISHER_NOT_AVAILABLE', message: 'Publishing is not connected yet', retryable: false };
  }
}
