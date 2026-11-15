-- N28 (1/2): additive only. Two new run states: CREATED (before the guardian's admission) and BLOCKED (refused by the guardian or the kill switch).
ALTER TYPE "AgentRunStatus" ADD VALUE 'CREATED';
ALTER TYPE "AgentRunStatus" ADD VALUE 'BLOCKED';
