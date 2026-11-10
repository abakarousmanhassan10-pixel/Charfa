export type ProviderErrorKind = 'auth' | 'rate_limit' | 'timeout' | 'server' | 'bad_request' | 'refusal' | 'network' | 'truncated';

/** Thrown when the provider has no credentials. Never retried; surfaced as "AI not configured". */
export class ProviderNotConfiguredError extends Error {
  constructor(
    readonly provider: string,
    readonly envVar: string,
  ) {
    super(`${provider} is not configured (set ${envVar}).`);
    this.name = 'ProviderNotConfiguredError';
  }
}

/** Provider call failure. The message never contains credentials or the prompt. */
export class ProviderError extends Error {
  constructor(
    readonly kind: ProviderErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
  get retryable() {
    return this.kind === 'rate_limit' || this.kind === 'timeout' || this.kind === 'server' || this.kind === 'network';
  }
}

/** The model answered, but the answer failed schema or safety validation after all repair attempts. */
export class OutputValidationError extends Error {
  constructor(readonly issues: string[]) {
    super(`AI output failed validation: ${issues.slice(0, 5).join('; ')}`);
    this.name = 'OutputValidationError';
  }
}
