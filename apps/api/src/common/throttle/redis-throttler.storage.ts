import { Logger } from '@nestjs/common';
import type { ThrottlerStorage } from '@nestjs/throttler';
import type { ThrottlerStorageRecord } from '@nestjs/throttler/dist/throttler-storage-record.interface';
import type Redis from 'ioredis';

/**
 * Fixed-window rate limiting shared by every API instance (atomic Lua script in Redis).
 * Semantics match the in-memory store: when the limit is exceeded the key is blocked for
 * blockDuration ms. If Redis is unreachable the request is allowed (fail open) and logged;
 * account lockout in the database still protects logins.
 */
const SCRIPT = `
local hitsKey = KEYS[1]
local blockKey = KEYS[2]
local ttl = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local block = tonumber(ARGV[3])
local blocked = redis.call('PTTL', blockKey)
if blocked > 0 then
  local hits = tonumber(redis.call('GET', hitsKey) or limit + 1)
  return {hits, redis.call('PTTL', hitsKey), 1, blocked}
end
local hits = redis.call('INCR', hitsKey)
if hits == 1 then redis.call('PEXPIRE', hitsKey, ttl) end
local pttl = redis.call('PTTL', hitsKey)
if hits > limit then
  redis.call('SET', blockKey, '1', 'PX', block)
  return {hits, pttl, 1, block}
end
return {hits, pttl, 0, 0}
`;

export class RedisThrottlerStorage implements ThrottlerStorage {
  private readonly logger = new Logger('RedisThrottler');
  private lastErrorLog = 0;

  constructor(
    private readonly redis: Redis,
    private readonly prefix = 'touma:rl:',
  ) {}

  async increment(key: string, ttl: number, limit: number, blockDuration: number, throttlerName: string): Promise<ThrottlerStorageRecord> {
    const base = `${this.prefix}${throttlerName}:${key}`;
    try {
      const [hits, pttl, blocked, blockMs] = (await this.redis.eval(SCRIPT, 2, `${base}:hits`, `${base}:block`, ttl, limit, blockDuration || ttl)) as number[];
      return {
        totalHits: hits!,
        timeToExpire: Math.max(0, Math.ceil(pttl! / 1000)),
        isBlocked: blocked === 1,
        timeToBlockExpire: blocked === 1 ? Math.max(1, Math.ceil(blockMs! / 1000)) : 0,
      };
    } catch (err) {
      if (Date.now() - this.lastErrorLog > 60_000) {
        this.lastErrorLog = Date.now();
        this.logger.error(`Rate limiting degraded (Redis unavailable): ${(err as Error).message}`);
      }
      return { totalHits: 0, timeToExpire: Math.ceil(ttl / 1000), isBlocked: false, timeToBlockExpire: 0 };
    }
  }
}
