import { AGENT_CATALOG, AGENT_TYPES, TASK_STATES, TASK_TRANSITIONS, canTaskTransition, costMicros, defaultAgentConfig, microsToUsdString, taskStateOf, usdPerMillionToMicros, validateAgentConfig } from './agents';

describe('agent catalog and configuration', () => {
  it('every agent type has a default configuration that validates', () => {
    for (const t of AGENT_TYPES) expect(validateAgentConfig(t, defaultAgentConfig(t))).toMatchObject({ ok: true });
    expect(AGENT_TYPES).toEqual(['RESEARCH', 'CONTENT', 'SUPPORT', 'ANALYTICS', 'SUPERVISOR']);
  });
  it('refuses unknown keys, permissions or tools the type does not have, and tools their permissions do not cover', () => {
    const base = defaultAgentConfig('RESEARCH');
    expect(validateAgentConfig('RESEARCH', { ...base, isAdmin: true })).toMatchObject({ ok: false });
    expect(validateAgentConfig('RESEARCH', { ...base, permissions: [...base.permissions, 'content.draft'] })).toMatchObject({ ok: false, error: expect.stringContaining('not allowed') });
    expect(validateAgentConfig('RESEARCH', { ...base, tools: [...base.tools, 'content.save_draft'] })).toMatchObject({ ok: false });
    expect(validateAgentConfig('RESEARCH', { ...base, permissions: ['catalog.read'] })).toMatchObject({ ok: false, error: expect.stringContaining('needs permission') }); // knowledge.lookup needs knowledge.read
    expect(validateAgentConfig('CONTENT', { ...defaultAgentConfig('CONTENT'), maxCostPerRunMicros: -1 })).toMatchObject({ ok: false });
    expect(validateAgentConfig('CONTENT', { ...defaultAgentConfig('CONTENT'), model: 'bad model!' })).toMatchObject({ ok: false });
    expect(validateAgentConfig('CONTENT', { ...defaultAgentConfig('CONTENT'), maxOutputTokens: 100_000 })).toMatchObject({ ok: false });
  });
  it('no agent can be given a publishing or sending tool', () => {
    for (const t of AGENT_TYPES) for (const tool of AGENT_CATALOG[t].tools) expect(tool).not.toMatch(/publish|send|post|spend|pay/);
    expect(AGENT_CATALOG.SUPERVISOR.permissions).toEqual(['run.review']);
  });
});

describe('task state machine', () => {
  it('has the requested states and a CREATED -> QUEUED -> RUNNING -> WAITING_APPROVAL -> COMPLETED path', () => {
    expect(TASK_STATES).toEqual(['CREATED', 'QUEUED', 'RUNNING', 'WAITING_APPROVAL', 'COMPLETED', 'FAILED', 'CANCELED', 'BLOCKED']);
    expect(canTaskTransition('CREATED', 'QUEUED')).toBe(true);
    expect(canTaskTransition('QUEUED', 'RUNNING')).toBe(true);
    expect(canTaskTransition('RUNNING', 'WAITING_APPROVAL')).toBe(true);
    expect(canTaskTransition('WAITING_APPROVAL', 'COMPLETED')).toBe(true);
  });
  it('final states stay final; a blocked or failed task can only be retried (queued)', () => {
    expect(TASK_TRANSITIONS.COMPLETED).toEqual([]);
    expect(TASK_TRANSITIONS.CANCELED).toEqual([]);
    expect(canTaskTransition('COMPLETED', 'RUNNING')).toBe(false);
    expect(canTaskTransition('CREATED', 'COMPLETED')).toBe(false);
    expect(canTaskTransition('BLOCKED', 'RUNNING')).toBe(false);
    expect(canTaskTransition('BLOCKED', 'QUEUED')).toBe(true);
    expect(canTaskTransition('FAILED', 'QUEUED')).toBe(true);
  });
  it('maps the run engine statuses', () => {
    expect(['CREATED', 'PENDING', 'RUNNING', 'WAITING_APPROVAL', 'COMPLETED', 'FAILED', 'CANCELLED', 'BLOCKED', 'PAUSED'].map(taskStateOf)).toEqual(['CREATED', 'QUEUED', 'RUNNING', 'WAITING_APPROVAL', 'COMPLETED', 'FAILED', 'CANCELED', 'BLOCKED', 'QUEUED']);
  });
});

describe('cost arithmetic in micro-units', () => {
  const price = { inputPerMillionMicros: 150_000, outputPerMillionMicros: 600_000, cachedInputPerMillionMicros: 75_000 };
  it('is exact and rounds up, never to zero for a paid call', () => {
    expect(costMicros({ input: 1_000_000, output: 1_000_000 }, price)).toBe(750_000);
    expect(costMicros({ input: 1, output: 0 }, price)).toBe(1);
    expect(costMicros({ input: 0, output: 0 }, price)).toBe(0);
    expect(costMicros({ input: 1000, output: 500 }, price)).toBe(450); // 150 + 300 micro-units
  });
  it('bills cached input tokens at the cached price and clamps nonsense', () => {
    expect(costMicros({ input: 1_000_000, output: 0, cached: 1_000_000 }, price)).toBe(75_000);
    expect(costMicros({ input: 1_000_000, output: 0, cached: 5_000_000 }, price)).toBe(75_000);
    expect(costMicros({ input: 1_000_000, output: 0, cached: 500_000 }, price)).toBe(112_500);
    expect(costMicros({ input: 1_000_000, output: 0, cached: -5 }, price)).toBe(150_000);
  });
  it('converts decimal prices without floats and formats micro-units', () => {
    expect(usdPerMillionToMicros('0.15')).toBe(150_000);
    expect(usdPerMillionToMicros('15')).toBe(15_000_000);
    expect(() => usdPerMillionToMicros('1e3')).toThrow();
    expect(microsToUsdString(450)).toBe('0.000450');
    expect(microsToUsdString(25_000_000)).toBe('25.000000');
  });
});
