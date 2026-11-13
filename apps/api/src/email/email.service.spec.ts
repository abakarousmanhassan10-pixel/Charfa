import nodemailer from 'nodemailer';
import { loadEnv } from '@touma/config';
import { EmailService, emails } from './email.service';

jest.mock('nodemailer');

const base = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  JWT_ACCESS_SECRET: 'a'.repeat(32),
  JWT_REFRESH_SECRET: 'b'.repeat(32),
  TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
  WEB_URL: 'https://app.example.com/',
  EMAIL_FROM: 'TOUMA AI <no-reply@mail.example.com>',
};

describe('EmailService', () => {
  const sendMail = jest.fn().mockResolvedValue({});
  const createTransport = nodemailer.createTransport as unknown as jest.Mock;
  beforeEach(() => {
    sendMail.mockClear();
    createTransport.mockReset().mockReturnValue({ sendMail, verify: jest.fn().mockResolvedValue(true) });
  });

  it('configures SMTP with TLS required in staging and short timeouts, so a stalled provider cannot hold a request', () => {
    const env = loadEnv({ ...base, APP_ENV: 'local', EMAIL_TRANSPORT: 'smtp', SMTP_HOST: 'smtp.example.com', SMTP_PORT: '587', SMTP_USER: 'user', SMTP_PASSWORD: 'pw' });
    new EmailService({ ...env, APP_ENV: 'staging' });
    const opts = createTransport.mock.calls[0][0];
    expect(opts).toMatchObject({ host: 'smtp.example.com', port: 587, secure: false, requireTLS: true, auth: { user: 'user', pass: 'pw' } });
    for (const k of ['connectionTimeout', 'greetingTimeout', 'socketTimeout', 'dnsTimeout']) expect(opts[k]).toBeLessThanOrEqual(20_000);
  });

  it('sends from EMAIL_FROM with both HTML and text parts and a tag header', async () => {
    const env = loadEnv({ ...base, EMAIL_TRANSPORT: 'smtp', SMTP_HOST: 'smtp.example.com' });
    const svc = new EmailService(env);
    await svc.send(emails.verification('amina@example.com', 'fr', svc.link('/verify-email', 'tok en')));
    const m = sendMail.mock.calls[0][0];
    expect(m).toMatchObject({ from: 'TOUMA AI <no-reply@mail.example.com>', to: 'amina@example.com', subject: 'Confirmez votre adresse e-mail', headers: { 'X-Touma-Tag': 'email-verification' } });
    expect(m.html).toContain('https://app.example.com/verify-email#token=tok%20en');
    expect(m.text).toContain('https://app.example.com/verify-email#token=tok%20en');
  });

  it('does not open a transport in log mode (development only) and reports it as unverified', async () => {
    const svc = new EmailService(loadEnv({ ...base }));
    await svc.send(emails.passwordChanged('a@example.com', 'en'));
    expect(createTransport).not.toHaveBeenCalled();
    expect(await svc.verify()).toBe(false);
  });

  it('builds the four transactional emails in English and French, with the link only where one is needed', () => {
    const url = 'https://app.example.com/x#token=abc';
    for (const locale of ['en', 'fr', 'de']) {
      const withLink = [emails.verification('a@example.com', locale, url), emails.passwordReset('a@example.com', locale, url), emails.invitation('a@example.com', locale, url, 'Maquis Awa', 'Amina', 'EDITOR')];
      for (const m of withLink) {
        expect(m.html).toContain(url);
        expect(m.text).toContain(url);
        expect(m.subject.length).toBeGreaterThan(5);
      }
      const changed = emails.passwordChanged('a@example.com', locale);
      expect(changed.html).not.toContain('http');
    }
    expect(emails.verification('a@example.com', 'de', 'https://app.example.com/x').subject).toBe('Confirm your email address'); // unknown locale falls back to English
  });
});
