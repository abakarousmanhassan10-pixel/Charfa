import { Injectable, Logger } from '@nestjs/common';
import nodemailer, { type Transporter } from 'nodemailer';
import { renderEmail } from '@touma/shared';
import { AppEnv, InjectEnv } from '../config';

export interface OutgoingEmail {
  to: string;
  subject: string;
  html: string;
  text: string;
  tag: string;
}

/**
 * Email delivery. smtp: real delivery through any SMTP provider (SES, Postmark, SendGrid,
 * Mailgun, Brevo...). log: development only; the message (with its links) goes to the server log.
 * Production validation refuses anything but smtp.
 */
@Injectable()
export class EmailService {
  private readonly logger = new Logger('Email');
  private readonly transporter?: Transporter;

  constructor(@InjectEnv() private readonly env: AppEnv) {
    if (env.EMAIL_TRANSPORT === 'smtp') {
      this.transporter = nodemailer.createTransport({
        host: env.SMTP_HOST,
        port: env.SMTP_PORT,
        secure: env.SMTP_SECURE,
        auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD } : undefined,
        // Upgrade to TLS when offered; refuse invalid certificates.
        requireTLS: env.APP_ENV === 'production' || env.APP_ENV === 'staging',
        // Sending happens inside the HTTP request (sign-up, password reset): a stalled provider must fail fast.
        // Nodemailer's own defaults would let an idle socket hold the request for up to an hour.
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
        socketTimeout: 20_000,
        dnsTimeout: 10_000,
      });
    }
  }

  get transport() {
    return this.env.EMAIL_TRANSPORT;
  }

  async send(mail: OutgoingEmail): Promise<void> {
    if (!this.transporter) {
      this.logger.log(`[dev email:${mail.tag}] to=${mail.to} subject="${mail.subject}"\n${mail.text}`);
      return;
    }
    await this.transporter.sendMail({ from: this.env.EMAIL_FROM, to: mail.to, subject: mail.subject, html: mail.html, text: mail.text, headers: { 'X-Touma-Tag': mail.tag } });
  }

  /** For health checks: verifies the SMTP connection and authentication (cached by caller). */
  async verify(): Promise<boolean> {
    if (!this.transporter) return false;
    try {
      return await this.transporter.verify();
    } catch {
      return false;
    }
  }

  link(path: string, token: string) {
    // Token in the URL fragment: never sent to servers or leaked through Referer headers.
    return `${this.env.WEB_URL.replace(/\/+$/, '')}${path}#token=${encodeURIComponent(token)}`;
  }
}

type L = 'en' | 'fr';
const lang = (l: string): L => (l === 'fr' ? 'fr' : 'en');

const T = {
  verify: {
    en: { subject: 'Confirm your email address', heading: 'Confirm your email', body: ['Welcome to TOUMA AI. Please confirm that this address belongs to you.', 'The link expires in 24 hours.'], action: 'Confirm my email', note: 'If you did not create an account, you can ignore this email.' },
    fr: { subject: 'Confirmez votre adresse e-mail', heading: 'Confirmez votre e-mail', body: ['Bienvenue sur TOUMA AI. Merci de confirmer que cette adresse vous appartient.', 'Le lien expire dans 24 heures.'], action: 'Confirmer mon e-mail', note: "Si vous n'avez pas créé de compte, ignorez cet e-mail." },
  },
  reset: {
    en: { subject: 'Reset your password', heading: 'Reset your password', body: ['We received a request to reset your TOUMA AI password.', 'The link expires in 30 minutes and can be used once.'], action: 'Choose a new password', note: 'If you did not ask for this, ignore this email: your password stays unchanged.' },
    fr: { subject: 'Réinitialisez votre mot de passe', heading: 'Réinitialisez votre mot de passe', body: ['Nous avons reçu une demande de réinitialisation de votre mot de passe TOUMA AI.', 'Le lien expire dans 30 minutes et ne peut servir qu’une fois.'], action: 'Choisir un nouveau mot de passe', note: "Si vous n'êtes pas à l'origine de cette demande, ignorez cet e-mail : votre mot de passe reste inchangé." },
  },
  changed: {
    en: { subject: 'Your password was changed', heading: 'Password changed', body: ['The password of your TOUMA AI account was just changed and all your sessions were signed out.', 'If this was not you, reset your password immediately and contact support.'], note: '' },
    fr: { subject: 'Votre mot de passe a été modifié', heading: 'Mot de passe modifié', body: ['Le mot de passe de votre compte TOUMA AI vient d’être modifié et toutes vos sessions ont été fermées.', "Si ce n'était pas vous, réinitialisez immédiatement votre mot de passe et contactez le support."], note: '' },
  },
  invite: {
    en: { subject: (b: string) => `You are invited to join ${b} on TOUMA AI`, heading: (b: string) => `Join ${b}`, body: (inviter: string, b: string, role: string) => [`${inviter} invited you to join ${b} on TOUMA AI as ${role}.`, 'The invitation expires in 7 days.'], action: 'Accept the invitation', note: 'If you were not expecting this invitation, you can ignore this email.' },
    fr: { subject: (b: string) => `Vous êtes invité(e) à rejoindre ${b} sur TOUMA AI`, heading: (b: string) => `Rejoignez ${b}`, body: (inviter: string, b: string, role: string) => [`${inviter} vous invite à rejoindre ${b} sur TOUMA AI en tant que ${role}.`, "L'invitation expire dans 7 jours."], action: "Accepter l'invitation", note: "Si vous n'attendiez pas cette invitation, ignorez cet e-mail." },
  },
};

const ROLE = { en: { OWNER: 'owner', ADMIN: 'admin', EDITOR: 'editor', VIEWER: 'viewer' }, fr: { OWNER: 'propriétaire', ADMIN: 'administrateur', EDITOR: 'éditeur', VIEWER: 'lecteur' } };

export const emails = {
  verification(to: string, locale: string, url: string): OutgoingEmail {
    const t = T.verify[lang(locale)];
    const r = renderEmail({ locale: lang(locale), preheader: t.subject, heading: t.heading, paragraphs: t.body, action: { label: t.action, url }, footerNote: t.note });
    return { to, subject: t.subject, ...r, tag: 'email-verification' };
  },
  passwordReset(to: string, locale: string, url: string): OutgoingEmail {
    const t = T.reset[lang(locale)];
    const r = renderEmail({ locale: lang(locale), preheader: t.subject, heading: t.heading, paragraphs: t.body, action: { label: t.action, url }, footerNote: t.note });
    return { to, subject: t.subject, ...r, tag: 'password-reset' };
  },
  passwordChanged(to: string, locale: string): OutgoingEmail {
    const t = T.changed[lang(locale)];
    const r = renderEmail({ locale: lang(locale), preheader: t.subject, heading: t.heading, paragraphs: t.body });
    return { to, subject: t.subject, ...r, tag: 'password-changed' };
  },
  invitation(to: string, locale: string, url: string, business: string, inviter: string, role: keyof typeof ROLE.en): OutgoingEmail {
    const l = lang(locale);
    const t = T.invite[l];
    const r = renderEmail({ locale: l, preheader: t.subject(business), heading: t.heading(business), paragraphs: t.body(inviter, business, ROLE[l][role]), action: { label: t.action, url }, footerNote: t.note });
    return { to, subject: t.subject(business), ...r, tag: 'invitation' };
  },
};
