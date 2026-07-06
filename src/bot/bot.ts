import TelegramBot from 'node-telegram-bot-api';
import { config } from '../config';
import { logger } from '../logger';
import { t, detectLang, type Lang } from '../i18n/i18n';
import { usersRepo, messagesRepo, composioRepo } from '../db/repositories';
import { runAgent } from '../ai/agent';
import { collectMedia, type CollectedMedia } from './media';
import type { ToolContext } from '../tools/types';
import {
  isComposioConfigured,
  availableApps,
  findApp,
  SUPPORTED_APPS,
} from '../integrations/composio/client';
import { startConnect, disconnectApp } from '../integrations/composio/connect';

export function createBot(): TelegramBot {
  const options: TelegramBot.ConstructorOptions = { polling: true };

  if (config.telegramInsecureTls) {
    logger.warn(
      'TELEGRAM_ALLOW_INSECURE_TLS=true — проверка TLS-сертификата Telegram отключена. ' +
        'Используй только для локальной отладки за VPN/антивирусом.',
    );
    // node-telegram-bot-api пробрасывает эти опции в HTTP-клиент.
    (options as any).request = { agentOptions: { rejectUnauthorized: false } };
  }

  const bot = new TelegramBot(config.telegramToken, options);

  // Ошибки поллинга не должны ронять процесс.
  bot.on('polling_error', (err) => logger.error({ err: err.message }, 'Ошибка Telegram polling'));

  bot.on('message', (msg) => {
    handleMessage(bot, msg).catch((err) => {
      logger.error({ err }, 'Необработанная ошибка в обработчике сообщения');
    });
  });

  bot.on('callback_query', (query) => {
    handleCallback(bot, query).catch((err) => {
      logger.error({ err }, 'Необработанная ошибка в обработчике кнопки');
    });
  });

  logger.info('Telegram-бот запущен (long polling)');
  return bot;
}

// Эмодзи для кнопок подключения по slug тулкита.
const APP_EMOJI: Record<string, string> = {
  gmail: '📧',
  googlecalendar: '📅',
  googlemeet: '🎥',
  googledocs: '📄',
  slack: '💬',
  notion: '📝',
  github: '🐙',
  linear: '📊',
};

/** Inline-клавиатура «подключить приложение» для всех доступных тулкитов. */
function connectKeyboard(): TelegramBot.InlineKeyboardMarkup {
  return {
    inline_keyboard: availableApps().map((app) => [
      {
        text: `${APP_EMOJI[app.slug] ?? '🔌'} ${app.name}`,
        callback_data: `connect:${app.slug}`,
      },
    ]),
  };
}

/** Inline-клавиатура «отвязать» для уже подключённых пользователем тулкитов. */
function disconnectKeyboard(userId: number): TelegramBot.InlineKeyboardMarkup {
  const rows = composioRepo.listToolkits(userId).map((slug) => {
    const name = SUPPORTED_APPS.find((a) => a.slug === slug)?.name ?? slug;
    return [{ text: `❌ ${APP_EMOJI[slug] ?? '🔌'} ${name}`, callback_data: `disconnect:${slug}` }];
  });
  return { inline_keyboard: rows };
}

/** Обрабатывает нажатия inline-кнопок (пока — подключение приложений). */
async function handleCallback(
  bot: TelegramBot,
  query: TelegramBot.CallbackQuery,
): Promise<void> {
  const data = query.data ?? '';
  const userId = query.from.id;
  const chatId = query.message?.chat.id;
  const lang: Lang = usersRepo.get(userId)?.language ?? 'ru';

  if (!chatId) {
    await bot.answerCallbackQuery(query.id).catch(() => {});
    return;
  }

  // Отвязка приложения по кнопке.
  if (data.startsWith('disconnect:')) {
    const app = findApp(data.slice('disconnect:'.length));
    await bot.answerCallbackQuery(query.id).catch(() => {});
    if (!app) {
      await bot.sendMessage(chatId, t('connect_unknown', lang));
      return;
    }
    try {
      await disconnectApp(userId, app.slug);
      await bot.sendMessage(chatId, t('disconnected', lang, { app: app.name }));
    } catch (err) {
      logger.error({ err, app: app.slug }, 'Ошибка отвязки приложения');
      await bot.sendMessage(chatId, t('error', lang));
    }
    return;
  }

  if (!data.startsWith('connect:')) {
    await bot.answerCallbackQuery(query.id).catch(() => {});
    return;
  }

  const app = findApp(data.slice('connect:'.length));
  if (!app) {
    await bot.answerCallbackQuery(query.id, { text: t('connect_unknown', lang) }).catch(() => {});
    return;
  }

  // Убираем «часики» на кнопке сразу, чтобы Telegram не показывал загрузку.
  await bot.answerCallbackQuery(query.id).catch(() => {});
  await bot.sendChatAction(chatId, 'typing').catch(() => {});

  try {
    const res = await startConnect(userId, app.slug);
    if (!res) {
      await bot.sendMessage(chatId, t('connect_unknown', lang));
      return;
    }
    if ('alreadyConnected' in res) {
      await bot.sendMessage(chatId, `${app.name}: уже подключено ✅`);
      return;
    }
    // Ссылку отдаём кнопкой — пользователю достаточно нажать «Авторизоваться».
    await bot.sendMessage(chatId, t('connect_link', lang, { app: app.name }), {
      reply_markup: {
        inline_keyboard: [[{ text: t('connect_open', lang, { app: app.name }), url: res.url }]],
      },
    });
  } catch (err) {
    logger.error({ err, app: app.slug }, 'Ошибка старта подключения Composio (кнопка)');
    await bot.sendMessage(chatId, t('error', lang));
  }
}

async function handleMessage(bot: TelegramBot, msg: TelegramBot.Message): Promise<void> {
  const chatId = msg.chat.id;
  const userId = msg.from?.id;
  if (!userId) return;

  const user = usersRepo.ensure(userId, chatId, msg.from?.username, msg.from?.first_name);
  let lang = user.language;

  // --- Команды (только для текстовых сообщений) ---
  const commandText = msg.text?.trim();
  if (commandText && commandText.startsWith('/')) {
    await handleCommand(bot, commandText, userId, chatId, lang);
    return;
  }

  // --- Вложения (фото, голосовое, аудио, документ) + текст/подпись ---
  let media: CollectedMedia = { parts: [], label: '' };
  try {
    media = await collectMedia(bot, msg);
  } catch (err) {
    logger.error({ err, userId }, 'Не удалось скачать вложение');
    await bot.sendMessage(chatId, t('error', lang));
    return;
  }

  const effectiveText = (msg.text ?? msg.caption ?? '').trim();

  // Не понимаем только то, где нет ни текста, ни поддерживаемого вложения (стикеры, гео и т.п.).
  if (!effectiveText && media.parts.length === 0) {
    await bot.sendMessage(chatId, t('only_text', lang));
    return;
  }

  // Автоопределение языка интерфейса по тексту (если пользователь не зафиксировал вручную).
  if (!user.language_locked && effectiveText) {
    const detected = detectLang(effectiveText);
    if (detected && detected !== lang) {
      usersRepo.updateDetected(userId, detected);
      lang = detected;
    }
  }

  // Для сообщений без текста (только вложение) даём модели нейтральную инструкцию.
  const promptText = effectiveText || 'Разбери вложение и помоги по сути на языке пользователя.';
  const historyLabel = effectiveText || media.label;

  // --- Прогоняем через Gemini ---
  try {
    const history = messagesRepo.recent(userId, config.historyLimit);
    const ctx: ToolContext = {
      userId,
      chatId,
      lang,
      timezone: config.timezone,
      senderName: msg.from?.first_name || msg.from?.username || 'Пользователь',
      senderUsername: msg.from?.username,
      sendTo: async (targetChatId, targetText) => {
        await bot.sendMessage(targetChatId, targetText);
      },
    };

    // Нативный индикатор Telegram «печатает…» — рисуется клиентом и выглядит
    // плавно. Действие живёт ~5 сек, поэтому продлеваем его, пока модель думает.
    await bot.sendChatAction(chatId, 'typing').catch(() => {});
    const typing = setInterval(() => {
      bot.sendChatAction(chatId, 'typing').catch(() => {});
    }, 4500);

    let reply: string;
    try {
      reply = await runAgent(history, promptText, ctx, media.parts);
    } finally {
      clearInterval(typing);
    }

    // Сохраняем ход диалога в историю (вложения не храним — только их метку).
    messagesRepo.add(userId, 'user', historyLabel);
    messagesRepo.add(userId, 'assistant', reply);

    await bot.sendMessage(chatId, reply);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err, userId, message }, 'Ошибка обработки сообщения через Gemini');
    const detail = config.debugErrors ? `\n\n[debug] ${message}` : '';
    await bot.sendMessage(chatId, t('error', lang) + detail);
  }
}

async function handleCommand(
  bot: TelegramBot,
  text: string,
  userId: number,
  chatId: number,
  lang: Lang,
): Promise<void> {
  const [command, arg] = text.split(/\s+/, 2);

  switch (command) {
    case '/start': {
      const showConnect = isComposioConfigured() && availableApps().length > 0;
      await bot.sendMessage(
        chatId,
        t('welcome', lang),
        showConnect ? { reply_markup: connectKeyboard() } : undefined,
      );
      return;
    }

    case '/help':
      await bot.sendMessage(chatId, t('help', lang));
      return;

    case '/language': {
      const choice = arg?.toLowerCase();
      if (choice === 'ru' || choice === 'kk') {
        usersRepo.setLanguage(userId, choice, true);
        await bot.sendMessage(chatId, t('language_set', choice));
      } else if (choice) {
        await bot.sendMessage(chatId, t('language_unknown', lang));
      } else {
        await bot.sendMessage(chatId, t('language_usage', lang, { lang }));
      }
      return;
    }

    case '/briefing': {
      const user = usersRepo.get(userId);
      const currentHour = user?.briefing_hour ?? 9;
      const choice = arg?.toLowerCase();

      if (choice === 'on') {
        usersRepo.setBriefing(userId, true, currentHour);
        await bot.sendMessage(chatId, t('briefing_on', lang, { hour: String(currentHour) }));
      } else if (choice === 'off') {
        usersRepo.setBriefing(userId, false, currentHour);
        await bot.sendMessage(chatId, t('briefing_off', lang));
      } else if (choice && /^\d{1,2}$/.test(choice) && Number(choice) >= 0 && Number(choice) <= 23) {
        usersRepo.setBriefing(userId, true, Number(choice));
        await bot.sendMessage(chatId, t('briefing_on', lang, { hour: choice }));
      } else {
        const state =
          user && user.briefing_enabled ? `${currentHour}:00` : t('briefing_off', lang);
        await bot.sendMessage(chatId, t('briefing_usage', lang, { state }));
      }
      return;
    }

    case '/connect': {
      if (!isComposioConfigured()) {
        await bot.sendMessage(chatId, t('composio_not_configured', lang));
        return;
      }
      const apps = availableApps();
      if (apps.length === 0) {
        await bot.sendMessage(chatId, t('composio_no_apps', lang));
        return;
      }
      const choice = arg?.toLowerCase();
      if (!choice) {
        // Показываем кнопки — печатать команду не нужно.
        await bot.sendMessage(chatId, t('connect_choose', lang), {
          reply_markup: connectKeyboard(),
        });
        return;
      }
      const app = findApp(choice);
      if (!app) {
        await bot.sendMessage(chatId, t('connect_unknown', lang));
        return;
      }
      try {
        const res = await startConnect(userId, app.slug);
        if (!res) {
          await bot.sendMessage(chatId, t('connect_unknown', lang));
          return;
        }
        if ('alreadyConnected' in res) {
          await bot.sendMessage(chatId, `${app.name}: уже подключено ✅`);
          return;
        }
        await bot.sendMessage(chatId, `${t('connect_link', lang, { app: app.name })}\n\n${res.url}`);
      } catch (err) {
        logger.error({ err, app: app.slug }, 'Ошибка старта подключения Composio');
        await bot.sendMessage(chatId, t('error', lang));
      }
      return;
    }

    case '/connections': {
      const toolkits = composioRepo.listToolkits(userId);
      if (toolkits.length === 0) {
        await bot.sendMessage(chatId, t('connections_empty', lang));
        return;
      }
      const names = toolkits.map((tk) => SUPPORTED_APPS.find((a) => a.slug === tk)?.name ?? tk);
      await bot.sendMessage(chatId, t('connections_list', lang, { list: names.join(', ') }));
      return;
    }

    case '/disconnect': {
      // С аргументом — отвязываем конкретное приложение (старый путь).
      if (arg) {
        const app = findApp(arg.toLowerCase());
        if (!app) {
          await bot.sendMessage(chatId, t('connect_unknown', lang));
          return;
        }
        await disconnectApp(userId, app.slug);
        await bot.sendMessage(chatId, t('disconnected', lang, { app: app.name }));
        return;
      }
      // Без аргумента — показываем кнопки подключённых приложений.
      const toolkits = composioRepo.listToolkits(userId);
      if (toolkits.length === 0) {
        await bot.sendMessage(chatId, t('connections_empty', lang));
        return;
      }
      await bot.sendMessage(chatId, t('disconnect_choose', lang), {
        reply_markup: disconnectKeyboard(userId),
      });
      return;
    }

    default:
      // Неизвестная команда — подсказываем помощь.
      await bot.sendMessage(chatId, t('help', lang));
      return;
  }
}
