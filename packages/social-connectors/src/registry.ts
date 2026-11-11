import { FacebookPublisher, InstagramPublisher } from './meta';
import { LinkedInPublisher } from './linkedin';
import { TikTokPublisher } from './tiktok';
import { YouTubePublisher } from './youtube';
import type { FetchLike } from './http';
import type { AdapterConfig, Platform, PlatformAdapter } from './types';

/** One adapter per platform, all using the same injectable network function. */
export function createAdapters(cfg: AdapterConfig, fetchImpl: FetchLike): Record<Platform, PlatformAdapter> {
  return {
    FACEBOOK: new FacebookPublisher(cfg, fetchImpl),
    INSTAGRAM: new InstagramPublisher(cfg, fetchImpl),
    TIKTOK: new TikTokPublisher(cfg, fetchImpl),
    YOUTUBE: new YouTubePublisher(cfg, fetchImpl),
    LINKEDIN: new LinkedInPublisher(cfg, fetchImpl),
  };
}

export { FacebookPublisher, InstagramPublisher, LinkedInPublisher, TikTokPublisher, YouTubePublisher };
