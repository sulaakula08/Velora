import TelegramBot from 'node-telegram-bot-api';
import { t, type Lang } from '../i18n/i18n';
import { logger } from '../logger';

// Кадры «дышащего» индикатора загрузки — меняются по кругу, пока модель думает.
const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const DOTS = ['', '.', '..', '...'];

const LOADER_INTERVAL_MS = 1100; // Telegram не любит слишком частые правки одного сообщения.
const TYPE_INTERVAL_MS = 600; // Шаг «печатной машинки» при выводе ответа.
const TYPE_MAX_STEPS = 5; // Сколько промежуточных правок делать максимум (беречь лимиты Telegram).
const CURSOR = '▌';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Безопасная правка сообщения: «not modified»/rate-limit не должны ронять поток. */
async function safeEdit(
  bot: TelegramBot,
  chatId: number,
  messageId: number,
  text: string,
): Promise<void> {
  try {
    await bot.editMessageText(text, { chat_id: chatId, message_id: messageId });
  } catch (err) {
    // «message is not modified», флуд-лимиты и т.п. — не критичны для UX.
    logger.debug({ err }, 'editMessageText пропущен');
  }
}

/** Разбивает ответ на нарастающие срезы для эффекта «печатается на глазах». */
function typewriterFrames(text: string): string[] {
  const steps = Math.min(TYPE_MAX_STEPS, Math.max(1, Math.ceil(text.length / 90)));
  if (steps <= 1) return [text];
  const frames: string[] = [];
  for (let i = 1; i < steps; i++) {
    const cut = Math.round((text.length * i) / steps);
    // Режем по границе пробела, чтобы слова не рвались посередине.
    const space = text.lastIndexOf(' ', cut);
    const end = space > cut - 15 ? space : cut;
    frames.push(text.slice(0, end).trimEnd() + ' ' + CURSOR);
  }
  frames.push(text); // Финальный кадр — полный текст без курсора.
  return frames;
}

/**
 * Показывает живой индикатор загрузки, выполняет работу, затем «печатает» ответ
 * посимвольно правками одного сообщения. Всегда завершает финальным полным
 * текстом; при любых сбоях правок гарантированно отправляет ответ обычным
 * сообщением.
 */
export async function withLiveReply(
  bot: TelegramBot,
  chatId: number,
  lang: Lang,
  work: () => Promise<string>,
): Promise<void> {
  const word = t('thinking', lang);
  const placeholder = await bot.sendMessage(chatId, `${SPINNER[0]} ${word}`);
  const messageId = placeholder.message_id;

  // Анимация индикатора, пока идёт работа.
  let frame = 0;
  let animating = true;
  const animation = (async () => {
    while (animating) {
      await sleep(LOADER_INTERVAL_MS);
      if (!animating) break;
      frame++;
      const text = `${SPINNER[frame % SPINNER.length]} ${word}${DOTS[frame % DOTS.length]}`;
      await safeEdit(bot, chatId, messageId, text);
    }
  })();

  let reply: string;
  try {
    reply = await work();
  } finally {
    animating = false;
    await animation.catch(() => {});
  }

  const text = reply.trim() || '…';

  // «Печатная машинка»: нарастающие правки одного сообщения.
  const frames = typewriterFrames(text);
  for (let i = 0; i < frames.length; i++) {
    if (i > 0) await sleep(TYPE_INTERVAL_MS);
    await safeEdit(bot, chatId, messageId, frames[i]);
  }

  // Страховка: если правки не прошли (лимиты/ошибки) — гарантируем доставку ответа.
  try {
    await bot.editMessageText(text, { chat_id: chatId, message_id: messageId });
  } catch {
    // Уже показан нужный текст либо сообщение не изменилось — это ок.
  }
}
