import { tasksRepo, remindersRepo, composioRepo } from '../db/repositories';
import { t, type Lang } from '../i18n/i18n';
import { isComposioConfigured } from '../integrations/composio/client';
import { executeComposioRaw } from '../integrations/composio/tools';
import { isPro } from '../billing/plans';
import { logger } from '../logger';

/** Эпоха конца текущего дня в часовом поясе (Asia/Almaty = +05:00, без летнего времени). */
function endOfTodayEpoch(tz: string): number {
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date()); // YYYY-MM-DD
  return new Date(`${date}T23:59:59+05:00`).getTime();
}

function fmtTime(epoch: number, tz: string): string {
  return new Intl.DateTimeFormat('ru-RU', { timeZone: tz, timeStyle: 'short' }).format(new Date(epoch));
}

/** Обрезает длинную строку (имя отправителя/тема), чтобы дайджест был компактным. */
function shorten(value: string, max = 60): string {
  const v = value.replace(/\s+/g, ' ').trim();
  return v.length > max ? v.slice(0, max - 1) + '…' : v;
}

/** Достаёт «отправитель — тема — краткое содержимое» из ответа GMAIL_FETCH_EMAILS. */
function parseEmails(data: any): { from: string; subject: string; snippet: string }[] {
  const arr: any[] =
    data?.messages ?? data?.emails ?? data?.data?.messages ?? (Array.isArray(data) ? data : []);
  if (!Array.isArray(arr)) return [];
  return arr.slice(0, 5).map((m) => {
    const subject = String(m?.subject ?? m?.Subject ?? '(без темы)');
    // Короткое содержимое письма, если доступно и небольшое.
    const raw = String(m?.snippet ?? m?.preview ?? m?.messageText ?? m?.body ?? m?.messageBody ?? '')
      .replace(/\s+/g, ' ')
      .trim();
    const snippet = raw && raw.toLowerCase() !== subject.toLowerCase() ? shorten(raw, 140) : '';
    return {
      from: shorten(String(m?.sender ?? m?.from ?? m?.From ?? '—').replace(/<[^>]*>/g, '').trim() || '—'),
      subject: shorten(subject),
      snippet,
    };
  });
}

/**
 * Дайджест непрочитанных писем во входящих — только если пользователь подключил
 * Gmail через Composio. При любой ошибке возвращает null (секция просто не попадёт
 * в брифинг, брифинг не ломается).
 */
async function buildEmailDigest(userId: number, lang: Lang): Promise<string | null> {
  if (!isComposioConfigured()) return null;
  if (!isPro(userId)) return null; // дайджест почты — функция Pro
  if (!composioRepo.listToolkits(userId).includes('gmail')) return null;

  try {
    const data = await executeComposioRaw(userId, 'GMAIL_FETCH_EMAILS', {
      user_id: 'me',
      max_results: 5,
      query: 'is:unread in:inbox',
    });
    const emails = parseEmails(data);
    if (emails.length === 0) return null;

    const lines = [t('briefing_email_header', lang, { count: String(emails.length) })];
    emails.forEach((e) => {
      lines.push(`• ${e.from} — ${e.subject}`);
      if (e.snippet) lines.push(`   ${e.snippet}`);
    });
    return lines.join('\n');
  } catch (err) {
    logger.warn({ err, userId }, 'Не удалось собрать дайджест почты для брифинга');
    return null;
  }
}

/**
 * Собирает текст утреннего брифинга: приветствие + задачи на сегодня (и просроченные)
 * + напоминания на сегодня + дайджест непрочитанной почты. Если ничего нет —
 * короткое пожелание хорошего дня.
 */
export async function buildBriefing(userId: number, lang: Lang, tz: string): Promise<string> {
  const end = endOfTodayEpoch(tz);
  const tasks = tasksRepo.dueBy(userId, end);
  const reminders = remindersRepo.pendingBy(userId, end);
  const emailDigest = await buildEmailDigest(userId, lang);

  if (tasks.length === 0 && reminders.length === 0 && !emailDigest) {
    return t('briefing_empty', lang);
  }

  const lines: string[] = [t('briefing_greeting', lang)];

  if (tasks.length > 0) {
    lines.push('', t('briefing_tasks_header', lang));
    tasks.forEach((tk, i) => lines.push(`${i + 1}. ${tk.title}`));
  }

  if (reminders.length > 0) {
    lines.push('', t('briefing_reminders_header', lang));
    reminders.forEach((r) => lines.push(`• ${fmtTime(r.remind_at, tz)} — ${r.text}`));
  }

  if (emailDigest) {
    lines.push('', emailDigest);
  }

  return lines.join('\n');
}
