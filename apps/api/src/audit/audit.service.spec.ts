import { redact } from './audit.service';

describe('redact', () => {
  it('removes credential-like keys recursively', () => {
    expect(
      redact({ email: 'a@b.c', password: 'x', nested: { accessToken: 'y', ok: 1 }, list: [{ apiKey: 'z' }] }),
    ).toEqual({
      email: 'a@b.c',
      password: '[REDACTED]',
      nested: { accessToken: '[REDACTED]', ok: 1 },
      list: [{ apiKey: '[REDACTED]' }],
    });
  });
});
