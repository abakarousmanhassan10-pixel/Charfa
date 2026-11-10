/**
 * Queue registry shared by the API (producers) and the worker (consumers).
 * Phase 7 adds the publication queue; phase 1 ships the maintenance queue only.
 */
export const QUEUES = {
  maintenance: 'aima.maintenance',
  // publication: 'aima.publication',      (phase 7)
  // analyticsSync: 'aima.analytics-sync', (phase 9)
  // tokenRefresh: 'aima.token-refresh',   (phase 6)
} as const;

export const DEFAULT_JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: 'exponential' as const, delay: 5_000 },
  removeOnComplete: { age: 24 * 3600, count: 1000 },
  removeOnFail: { age: 7 * 24 * 3600 },
};

export type MaintenanceJob = { type: 'purge-expired-sessions' };
