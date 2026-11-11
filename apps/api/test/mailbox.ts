import { SMTPServer } from 'smtp-server';

export interface ReceivedMail {
  from: string;
  to: string[];
  raw: string;
  subject: string;
  text: string;
}

/** Decodes quoted-printable soft breaks and escapes enough to read links. */
function decodeQP(s: string) {
  return s.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

/**
 * Real SMTP server (smtp-server) used as the test mailbox: the API delivers through nodemailer
 * over TCP exactly as in production, and tests read the received messages.
 */
export class Mailbox {
  readonly messages: ReceivedMail[] = [];
  private server: SMTPServer;

  constructor(private readonly port = Number(process.env.SMTP_PORT ?? 2525)) {
    this.server = new SMTPServer({
      authOptional: true,
      disabledCommands: ['STARTTLS', 'AUTH'],
      logger: false,
      onData: (stream, session, cb) => {
        const chunks: Buffer[] = [];
        stream.on('data', (c: Buffer) => chunks.push(c));
        stream.on('end', () => {
          const raw = decodeQP(Buffer.concat(chunks).toString('utf8'));
          const subject = /^Subject: (.*)$/m.exec(raw)?.[1] ?? '';
          this.messages.push({ from: session.envelope.mailFrom ? (session.envelope.mailFrom as { address: string }).address : '', to: session.envelope.rcptTo.map((r) => r.address), raw, subject, text: raw });
          cb();
        });
      },
    });
  }

  start() {
    return new Promise<void>((resolve) => this.server.listen(this.port, '127.0.0.1', () => resolve()));
  }

  stop() {
    return new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  clear() {
    this.messages.length = 0;
  }

  /** Waits for a message to an address and returns the token from its link (#token=...). */
  async waitFor(to: string, tag: string, timeoutMs = 5000) {
    const until = Date.now() + timeoutMs;
    for (;;) {
      const m = [...this.messages].reverse().find((x) => x.to.includes(to.toLowerCase()) && x.raw.includes(`X-Touma-Tag: ${tag}`));
      if (m) return { mail: m, token: /#token=([A-Za-z0-9_-]+)/.exec(m.raw)?.[1] ?? null };
      if (Date.now() > until) throw new Error(`No ${tag} email to ${to}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}
