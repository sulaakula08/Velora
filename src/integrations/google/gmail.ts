import { google } from 'googleapis';
import type { GoogleClient } from './oauth';

export interface EmailSummary {
  from: string;
  subject: string;
  snippet: string;
}

/** Сводка последних писем во входящих. */
export async function listRecent(client: GoogleClient, max = 5): Promise<EmailSummary[]> {
  const gmail = google.gmail({ version: 'v1', auth: client });
  const list = await gmail.users.messages.list({ userId: 'me', maxResults: max, q: 'in:inbox' });
  const messages = list.data.messages ?? [];

  const out: EmailSummary[] = [];
  for (const m of messages) {
    if (!m.id) continue;
    const full = await gmail.users.messages.get({
      userId: 'me',
      id: m.id,
      format: 'metadata',
      metadataHeaders: ['From', 'Subject'],
    });
    const headers = full.data.payload?.headers ?? [];
    const from = headers.find((h) => h.name === 'From')?.value ?? '';
    const subject = headers.find((h) => h.name === 'Subject')?.value ?? '(без темы)';
    out.push({ from, subject, snippet: full.data.snippet ?? '' });
  }
  return out;
}

/** Кодирует и отправляет письмо (UTF-8, plain text). */
export async function sendEmail(
  client: GoogleClient,
  to: string,
  subject: string,
  body: string,
): Promise<void> {
  const gmail = google.gmail({ version: 'v1', auth: client });
  const subjectEnc = `=?UTF-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`;
  const message = [
    `To: ${to}`,
    `Subject: ${subjectEnc}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    '',
    body,
  ].join('\r\n');
  const raw = Buffer.from(message, 'utf8').toString('base64url');
  await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });
}
