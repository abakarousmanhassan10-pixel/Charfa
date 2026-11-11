import { Injectable } from '@nestjs/common';
import type { PublishingGateway, PublishingOutcome, PublishingRequest } from '../calendar/publishing';
import { SocialPublisherService } from './social-publisher.service';

/** The calendar's PUBLISHING_GATEWAY: hands due, authorized entries to the central publishing engine (idempotent on the dispatch key). */
@Injectable()
export class SocialPublishingGateway implements PublishingGateway {
  readonly name = 'social';
  constructor(private readonly publisher: SocialPublisherService) {}

  isAvailable() {
    return this.publisher.available();
  }

  submit(request: PublishingRequest): Promise<PublishingOutcome> {
    return this.publisher.accept(request);
  }
}
