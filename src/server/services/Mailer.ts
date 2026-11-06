import nodemailer, { type Transporter } from 'nodemailer';
import { config } from '../config';

let transport: Transporter | null = null;

/** Whether email can be sent (SMTP settings and PUBLIC_URL are all present). */
export function mailEnabled(): boolean {
  const { host, user, pass } = config.smtp;
  return !!(host && user && pass && config.publicUrl);
}

if (!mailEnabled() && (config.smtp.host || config.smtp.user)) {
  console.warn('[mail] SMTP is partly configured: set SMTP_HOST, SMTP_USER, SMTP_PASS and PUBLIC_URL to turn on "Forgot PIN?".');
}

function getTransport(): Transporter {
  transport ??= nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    requireTLS: !config.smtp.secure, // port 587: refuse to send without STARTTLS
    auth: { user: config.smtp.user, pass: config.smtp.pass },
  });
  return transport;
}

export interface Mail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

/** Sends one email. Throws if SMTP is off or the server refuses it. */
export async function sendMail(mail: Mail): Promise<void> {
  if (!mailEnabled()) throw new Error('Email is not set up on this server');
  await getTransport().sendMail({ from: config.smtp.from || `Call9me <${config.smtp.user}>`, ...mail });
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);

/** Sent to the OLD address when an ID's recovery email is changed or removed. */
export function recoveryChangedMail(to: string, userId: string, newEmail: string): Mail {
  const what = newEmail ? 'was changed to another address' : 'was removed';
  return {
    to,
    subject: 'Your Call9me recovery email was changed',
    text:
      `Hi ${userId},\n\nThe recovery email of your Call9me ID "${userId}" ${what}, so PIN reset links no longer come here.\n\n` +
      `If this wasn't you, ask an admin to suspend the ID and set a new PIN.\n`,
    html:
      `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:480px;margin:auto;color:#151a30">` +
      `<h2 style="margin:0 0 12px">Recovery email changed</h2>` +
      `<p>The recovery email of your Call9me ID <strong>${escapeHtml(userId)}</strong> ${what}, so PIN reset links no longer come here.</p>` +
      `<p style="color:#646b88;font-size:14px">If this wasn't you, ask an admin to suspend the ID and set a new PIN.</p></div>`,
  };
}

/** The "reset your PIN" email. */
export function pinResetMail(to: string, userId: string, link: string, minutes: number): Mail {
  const id = escapeHtml(userId);
  const href = escapeHtml(link);
  return {
    to,
    subject: 'Reset your Call9me PIN',
    text:
      `Hi ${userId},\n\nSomeone (hopefully you) asked to reset the PIN of your Call9me ID "${userId}".\n\n` +
      `Choose a new PIN here (the link works once, for ${minutes} minutes):\n${link}\n\n` +
      `If you didn't ask for this, ignore this email: your PIN stays the same.\n`,
    html:
      `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:480px;margin:auto;color:#151a30">` +
      `<h2 style="margin:0 0 12px">Reset your PIN</h2>` +
      `<p>Hi <strong>${id}</strong>, someone (hopefully you) asked to reset the PIN of your Call9me ID.</p>` +
      `<p style="margin:24px 0"><a href="${href}" style="background:#6d5dfc;color:#fff;padding:12px 20px;border-radius:10px;text-decoration:none;font-weight:600">Choose a new PIN</a></p>` +
      `<p style="color:#646b88;font-size:14px">The link works once, for ${minutes} minutes. If you didn't ask for this, ignore this email: your PIN stays the same.</p>` +
      `</div>`,
  };
}
