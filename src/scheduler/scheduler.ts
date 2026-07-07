import cron from 'node-cron';
import type TelegramBot from 'node-telegram-bot-api';
import { remindersRepo, tasksRepo, usersRepo, scheduledRepo } from '../db/repositories';
import { buildBriefing } from './briefing';
import { t } from '../i18n/i18n';
import { config } from '../config';
import { logger } from '../logger';
import { executeComposioRaw } from '../integrations/composio/tools';

/** Локальные дата/час/минута в заданном часовом поясе. */
function localParts(tz: string): { date: string; hour: number; minute: number } {
  const now = new Date();
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(now); // YYYY-MM-DD
  const hm = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(now); // HH:MM
  const [hour, minute] = hm.split(':').map(Number);
  return { date, hour, minute };
}

/**
 * Единый планировщик (раз в минуту):
 *  - наступившие напоминания;
 *  - follow-up по задачам («ты собирался…, получилось?»);
 *  - утренний брифинг в заданный пользователем час.
 * Каждая часть изолирована try/catch — сбой одной не ломает остальные.
 */
export function startScheduler(bot: TelegramBot): void {
  cron.schedule('* * * * *', async () => {
    await sendDueReminders(bot);
    await sendDueFollowUps(bot);
    await sendDueScheduledMessages(bot);
    await sendBriefings(bot);
  });

  logger.info('Планировщик запущен: напоминания, follow-up, отложенные отправки, брифинги (раз в минуту)');
}

/** Отправляет запланированные пользователем сообщения/письма, у которых наступило время. */
async function sendDueScheduledMessages(bot: TelegramBot): Promise<void> {
  let due;
  try {
    due = scheduledRepo.getDue(Date.now());
  } catch (err) {
    logger.error({ err }, 'Ошибка чтения отложенных сообщений');
    return;
  }

  for (const m of due) {
    const owner = usersRepo.get(m.user_id);
    const lang = owner?.language ?? 'ru';
    try {
      if (m.channel === 'telegram') {
        const username = m.target.replace(/^@/, '');
        const target = usersRepo.findByUsername(username);
        if (!target?.chat_id) throw new Error(`получатель @${username} не в Velora`);
        const sender = owner?.username ? `@${owner.username}` : owner?.first_name || 'Пользователь';
        await bot.sendMessage(target.chat_id, t('relayed_message', target.language, { sender, message: m.body }));
      } else {
        await executeComposioRaw(m.user_id, 'GMAIL_SEND_EMAIL', {
          recipient_email: m.target,
          subject: m.subject || '(без темы)',
          body: m.body,
        });
      }
      scheduledRepo.markSent(m.id);
      await bot.sendMessage(m.chat_id, t('scheduled_sent', lang, { target: m.target })).catch(() => {});
    } catch (err) {
      logger.error({ err, id: m.id }, 'Не удалось отправить отложенное сообщение');
      scheduledRepo.markSent(m.id); // не зацикливаемся на битой записи
      await bot.sendMessage(m.chat_id, t('scheduled_failed', lang, { target: m.target })).catch(() => {});
    }
  }
}

async function sendDueReminders(bot: TelegramBot): Promise<void> {
  let due;
  try {
    due = remindersRepo.getDue(Date.now());
  } catch (err) {
    logger.error({ err }, 'Ошибка чтения напоминаний');
    return;
  }
  for (const reminder of due) {
    try {
      await bot.sendMessage(reminder.chat_id, t('reminder_due', reminder.language, { text: reminder.text }));
      remindersRepo.markSent(reminder.id);
    } catch (err) {
      logger.error({ err, id: reminder.id }, 'Не удалось отправить напоминание');
    }
  }
}

async function sendDueFollowUps(bot: TelegramBot): Promise<void> {
  let due;
  try {
    due = tasksRepo.getDueFollowUps(Date.now());
  } catch (err) {
    logger.error({ err }, 'Ошибка чтения follow-up задач');
    return;
  }
  for (const task of due) {
    try {
      await bot.sendMessage(task.chat_id, t('followup', task.language, { task: task.title }));
      tasksRepo.markFollowedUp(task.id);
    } catch (err) {
      logger.error({ err, id: task.id }, 'Не удалось отправить follow-up');
    }
  }
}

async function sendBriefings(bot: TelegramBot): Promise<void> {
  const { date, hour, minute } = localParts(config.timezone);
  // Брифинг отправляем строго в начале нужного часа.
  if (minute !== 0) return;

  let candidates;
  try {
    candidates = usersRepo.briefingCandidates();
  } catch (err) {
    logger.error({ err }, 'Ошибка чтения кандидатов на брифинг');
    return;
  }

  for (const user of candidates) {
    if (user.briefing_hour !== hour) continue;
    if (user.last_briefing_date === date) continue; // уже отправляли сегодня
    try {
      const text = await buildBriefing(user.user_id, user.language, config.timezone);
      await bot.sendMessage(user.chat_id, text);
      usersRepo.markBriefingSent(user.user_id, date);
    } catch (err) {
      logger.error({ err, userId: user.user_id }, 'Не удалось отправить брифинг');
    }
  }
}
