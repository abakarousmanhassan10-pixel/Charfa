import { Injectable } from '@nestjs/common';

/** A failure raised by an adapter. `retryable` is a hint: steps that act outside TOUMA are never retried automatically. */
export class RunStepError extends Error {
  constructor(readonly code: string, message: string, readonly retryable = false) {
    super(message);
    this.name = 'RunStepError';
  }
}

export interface RunAdapterContext {
  runId: string;
  stepKey: string;
  businessId: string;
  /** Stable per step (`<run>:<step>`): an adapter that talks to the outside world must use it to deduplicate. */
  idempotencyKey: string;
  input: Record<string, unknown>;
  /** Outputs of the steps this step depends on. */
  outputs: Record<string, Record<string, unknown>>;
}

export interface RunAdapter {
  readonly name: string;
  /** True when the adapter acts outside TOUMA (publishes, sends, spends). Such a step always needs a human approval. */
  readonly external: boolean;
  execute(ctx: RunAdapterContext): Promise<Record<string, unknown>>;
}

export interface RunAdapterRegistry {
  get(name: string): RunAdapter | undefined;
}

/** true = acts outside TOUMA, false = internal, undefined = no such adapter. */
export const adapterIsExternal = (registry: RunAdapterRegistry) => (name: string): boolean | undefined => registry.get(name)?.external;

export const RUN_ADAPTER_REGISTRY = Symbol('RUN_ADAPTER_REGISTRY');

/**
 * Phase N2: the only adapters that exist. They are deterministic simulations (no model call, no network, no external
 * action) and carry test hooks to inject failures and delays and to count how often each one really ran.
 */
@Injectable()
export class SimulatedRunAdapters implements RunAdapterRegistry {
  readonly calls: Record<string, number> = {};
  private failures = new Map<string, { times: number; retryable: boolean; code: string }>();
  private delays = new Map<string, { times: number; ms: number }>();

  private readonly adapters: Record<string, RunAdapter> = {
    'simulated.analyze': this.make('simulated.analyze', false, (ctx) => ({ summary: `Simulated analysis of the topic (${String(ctx.input.topic ?? '').length} characters)`, simulated: true })),
    'simulated.draft': this.make('simulated.draft', false, (ctx) => ({ draft: 'Simulated draft', basedOn: Object.keys(ctx.outputs), simulated: true })),
    'simulated.external-action': this.make('simulated.external-action', true, () => ({ simulated: true, note: 'No external action was performed' })),
    // Phase N3 workflow adapters (simulations as well: no model, no calendar write, nothing leaves TOUMA).
    'simulated.product-analysis': this.make('simulated.product-analysis', false, (ctx) => ({ summary: `Simulated product analysis (${String(ctx.input.topic ?? ctx.input.product ?? '').length} characters)`, score: 72, simulated: true })),
    'simulated.content-draft': this.make('simulated.content-draft', false, (ctx) => ({ draft: 'Simulated content draft', basedOn: Object.keys(ctx.outputs), simulated: true })),
    'simulated.calendar-schedule': this.make('simulated.calendar-schedule', true, () => ({ simulated: true, scheduled: false, note: 'No calendar entry was created' })),
  };

  get(name: string) {
    return this.adapters[name];
  }

  /** Test hook: the next `times` executions of an adapter fail. */
  failNext(adapter: string, times: number, retryable = true, code = 'SIMULATED_FAILURE') {
    this.failures.set(adapter, { times, retryable, code });
  }

  /** Test hook: the next `times` executions of an adapter take `ms` more milliseconds. */
  slowNext(adapter: string, ms: number, times = 1) {
    this.delays.set(adapter, { times, ms });
  }

  reset() {
    for (const k of Object.keys(this.calls)) delete this.calls[k];
    this.failures.clear();
    this.delays.clear();
  }

  private make(name: string, external: boolean, run: (ctx: RunAdapterContext) => Record<string, unknown>): RunAdapter {
    return {
      name,
      external,
      execute: async (ctx) => {
        this.calls[name] = (this.calls[name] ?? 0) + 1;
        const slow = this.delays.get(name);
        if (slow && slow.times > 0) {
          slow.times--;
          await new Promise((r) => setTimeout(r, slow.ms));
        }
        const f = this.failures.get(name);
        if (f && f.times > 0) {
          f.times--;
          throw new RunStepError(f.code, 'Simulated adapter failure', f.retryable);
        }
        return run(ctx);
      },
    };
  }
}
