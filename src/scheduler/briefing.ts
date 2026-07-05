import { tasksRepo, remindersRepo } from '../db/repositories';
import { t, type Lang } from '../i18n/i18n';

/** Эпоха конца текущего дня в часовом поясе (Asia/Almaty = +05:00, без летнего времени). */
function endOfTodayEpoch(tz: string): number {
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date()); // YYYY-MM-DD
  return new Date(`${date}T23:59:59+05:00`).getTime();
}

function fmtTime(epoch: number, tz: string): string {
  return new Intl.DateTimeFormat('ru-RU', { timeZone: tz, timeStyle: 'short' }).format(new Date(epoch));
}

/**
 * Собирает текст утреннего брифинга: приветствие + задачи на сегодня (и просроченные)
 * + напоминания на сегодня. Если ничего нет — короткое пожелание хорошего дня.
 */
export function buildBriefing(userId: number, lang: Lang, tz: string): string {
  const end = endOfTodayEpoch(tz);
  const tasks = tasksRepo.dueBy(userId, end);
  const reminders = remindersRepo.pendingBy(userId, end);

  if (tasks.length === 0 && reminders.length === 0) {
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

  return lines.join('\n');
}
