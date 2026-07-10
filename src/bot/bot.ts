import TelegramBot from 'node-telegram-bot-api';
import { config } from '../config';
import { logger } from '../logger';
import { t, detectLang, type Lang } from '../i18n/i18n';
import { usersRepo, messagesRepo, composioRepo, subscriptionsRepo, statsRepo, feedbackRepo, maintenanceRepo, type VoiceMode } from '../db/repositories';
import { runAgent } from '../ai/agent';
import { synthesizeVoice } from '../ai/tts';
import { fetchStarInfo } from '../billing/starsBalance';
import { collectMedia, type CollectedMedia } from './media';
import type { ToolContext } from '../tools/types';
import {
  isComposioConfigured,
  availableApps,
  findApp,
  SUPPORTED_APPS,
} from '../integrations/composio/client';
import { startConnect, disconnectApp } from '../integrations/composio/connect';
import {
  getPlan,
  isPro,
  checkDailyLimit,
  canConnectMore,
  checkoutUrlFor,
  billingEnabled,
  starsEnabled,
  lemonEnabled,
  grantProDays,
  grantProUnlimited,
  promoActive,
  priceFor,
  daysFor,
  type BillingPeriod,
} from '../billing/plans';

// Пользователи, от которых ждём текст отзыва (после нажатия кнопки в /feedback).
const pendingFeedback = new Map<number, { anonymous: boolean }>();

/** Отключает все подключённые пользователем интеграции. */
async function disconnectAllApps(userId: number): Promise<void> {
  for (const slug of composioRepo.listToolkits(userId)) {
    await disconnectApp(userId, slug).catch(() => {});
  }
}

/** Превращает **жирный** из ответа модели в настоящий жирный (Telegram HTML). */
function renderHtml(text: string): string {
  const esc = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return esc.replace(/\*\*(.+?)\*\*/gs, '<b>$1</b>').replace(/__(.+?)__/gs, '<b>$1</b>');
}

/** Отправляет ответ модели с жирным; при сбое HTML — чистым текстом без звёздочек. */
async function sendReply(bot: TelegramBot, chatId: number, text: string): Promise<void> {
  try {
    await bot.sendMessage(chatId, renderHtml(text), { parse_mode: 'HTML' });
  } catch {
    await bot.sendMessage(chatId, text.replace(/\*\*/g, '').replace(/__/g, ''));
  }
}

/** Зачёркивает текст (Unicode) — для «старой» цены в промо: 250 → 2̶5̶0̶. */
function strike(s: string): string {
  return s.split('').map((c) => c + '̶').join('');
}

/** Промо-баннер со скидкой (или пустая строка, если акции нет). */
function promoBanner(lang: Lang): string {
  if (!promoActive()) return '';
  return t('promo_banner', lang, {
    old: strike(String(config.proStarsPrice)),
    promo: String(config.proStarsPromo),
  });
}

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

  // Оплата Telegram Stars: подтверждаем pre-checkout (обязательно в течение 10 сек).
  bot.on('pre_checkout_query', (q) => {
    bot.answerPreCheckoutQuery(q.id, true).catch((err) =>
      logger.error({ err }, 'Ошибка ответа на pre_checkout_query'),
    );
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
  googlesheets: '📊',
  googleslides: '📽️',
  google_classroom: '🎓',
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
function disconnectKeyboard(userId: number, lang: Lang): TelegramBot.InlineKeyboardMarkup {
  const rows = composioRepo.listToolkits(userId).map((slug) => {
    const name = SUPPORTED_APPS.find((a) => a.slug === slug)?.name ?? slug;
    return [{ text: `❌ ${APP_EMOJI[slug] ?? '🔌'} ${name}`, callback_data: `disconnect:${slug}` }];
  });
  if (rows.length > 1) {
    rows.push([{ text: t('disconnect_all_btn', lang), callback_data: 'disconnect:__all__' }]);
  }
  return { inline_keyboard: rows };
}

/** Inline-кнопка «Оформить Pro» — по нажатию запускается оплата (Stars/ссылка). */
function upgradeKeyboard(lang: Lang): TelegramBot.InlineKeyboardMarkup {
  return { inline_keyboard: [[{ text: t('upgrade_button', lang), callback_data: 'upgrade' }]] };
}

/** Клавиатура выбора плана: месяц (с промо) или год (выгоднее). */
function planChoiceKeyboard(lang: Lang): TelegramBot.InlineKeyboardMarkup {
  const month = promoActive() ? config.proStarsPromo : config.proStarsPrice;
  return {
    inline_keyboard: [
      [{ text: t('plan_btn_month', lang, { price: String(month) }), callback_data: 'buy:month' }],
      [{ text: t('plan_btn_year', lang, { price: String(config.proStarsPriceYear) }), callback_data: 'buy:year' }],
    ],
  };
}

/** Показывает оффер Pro и выбор плана (или ведёт на внешний чекаут / сообщает, что оплата выключена). */
async function startUpgrade(
  bot: TelegramBot,
  chatId: number,
  userId: number,
  lang: Lang,
): Promise<void> {
  if (isPro(userId)) {
    await bot.sendMessage(chatId, t('already_pro', lang));
    return;
  }
  if (starsEnabled()) {
    const banner = promoBanner(lang);
    const text = t('upgrade_prompt', lang) + (banner ? `\n\n${banner}` : '');
    await bot.sendMessage(chatId, text, { reply_markup: planChoiceKeyboard(lang) });
    return;
  }
  if (lemonEnabled()) {
    await bot.sendMessage(chatId, t('upgrade_prompt', lang), {
      reply_markup: { inline_keyboard: [[{ text: t('upgrade_button', lang), url: checkoutUrlFor(userId) }]] },
    });
    return;
  }
  await bot.sendMessage(chatId, t('billing_off', lang));
}

/** Выставляет счёт в Telegram Stars на выбранный период. */
async function sendProInvoice(
  bot: TelegramBot,
  chatId: number,
  userId: number,
  lang: Lang,
  period: BillingPeriod,
): Promise<void> {
  const days = daysFor(period);
  const banner = period === 'month' ? promoBanner(lang) : '';
  const desc = (banner ? banner + '\n\n' : '') + t('pro_invoice_desc', lang, { days: String(days) });
  await bot.sendInvoice(
    chatId,
    t('pro_invoice_title', lang),
    desc.slice(0, 255),
    `pro_stars:${period}:${userId}`,
    '', // для Stars provider_token пустой
    'XTR',
    [{ label: t('pro_invoice_title', lang), amount: priceFor(period) }],
  );
}

/** Inline-клавиатура выбора режима голосовых ответов. */
function voiceKeyboard(lang: Lang): TelegramBot.InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [{ text: t('voice_btn_always', lang), callback_data: 'voice:always' }],
      [{ text: t('voice_btn_reply', lang), callback_data: 'voice:reply' }],
      [{ text: t('voice_btn_off', lang), callback_data: 'voice:off' }],
    ],
  };
}

/** Обрабатывает нажатия inline-кнопок (подключение приложений, режим голоса). */
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

  // Выбор режима отзыва → ждём следующее сообщение как отзыв.
  if (data === 'fb:named' || data === 'fb:anon') {
    await bot.answerCallbackQuery(query.id).catch(() => {});
    pendingFeedback.set(userId, { anonymous: data === 'fb:anon' });
    await bot.sendMessage(chatId, t('feedback_prompt', lang));
    return;
  }

  // Кнопка «Оформить Pro» → показать выбор плана.
  if (data === 'upgrade') {
    await bot.answerCallbackQuery(query.id).catch(() => {});
    await startUpgrade(bot, chatId, userId, lang);
    return;
  }

  // Выбор плана → выставляем счёт.
  if (data === 'buy:month' || data === 'buy:year') {
    await bot.answerCallbackQuery(query.id).catch(() => {});
    if (isPro(userId)) {
      await bot.sendMessage(chatId, t('already_pro', lang));
      return;
    }
    const period: BillingPeriod = data === 'buy:year' ? 'year' : 'month';
    await sendProInvoice(bot, chatId, userId, lang, period);
    return;
  }

  // Выбор режима голосовых ответов.
  if (data.startsWith('voice:')) {
    await bot.answerCallbackQuery(query.id).catch(() => {});
    const mode = data.slice('voice:'.length) as VoiceMode;
    usersRepo.setVoiceMode(userId, mode);
    const key = mode === 'always' ? 'voice_on_always' : mode === 'reply' ? 'voice_on_reply' : 'voice_off';
    await bot.sendMessage(chatId, t(key, lang));
    return;
  }

  // Отвязка приложения по кнопке.
  if (data.startsWith('disconnect:')) {
    const slug = data.slice('disconnect:'.length);
    await bot.answerCallbackQuery(query.id).catch(() => {});
    // Отключить всё сразу.
    if (slug === '__all__') {
      await disconnectAllApps(userId);
      await bot.sendMessage(chatId, t('disconnected_all', lang));
      return;
    }
    const app = findApp(slug);
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

  if (!composioRepo.listToolkits(userId).includes(app.slug) && !canConnectMore(userId)) {
    await bot.sendMessage(
      chatId,
      t('connect_limit', lang, { limit: String(config.freeMaxIntegrations) }),
      billingEnabled() ? { reply_markup: upgradeKeyboard(lang) } : undefined,
    );
    return;
  }

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

  // --- Успешная оплата Telegram Stars → выдаём Pro ---
  if (msg.successful_payment) {
    const sp = msg.successful_payment;
    const charge = sp.telegram_payment_charge_id ?? null;
    const period: BillingPeriod = (sp.invoice_payload ?? '').includes(':year') ? 'year' : 'month';
    grantProDays(userId, daysFor(period), 'stars', charge);
    logger.info({ userId, charge, period }, 'Оплата Stars получена, Pro выдан');
    await bot.sendMessage(chatId, t('pro_activated', lang));
    return;
  }

  // --- Команды (только для текстовых сообщений) ---
  const commandText = msg.text?.trim();

  // Если ждём отзыв от пользователя — перехватываем следующее НЕ-командное сообщение.
  if (pendingFeedback.has(userId)) {
    if (commandText && !commandText.startsWith('/')) {
      const mode = pendingFeedback.get(userId)!;
      pendingFeedback.delete(userId);
      feedbackRepo.add(userId, msg.from?.username, commandText, mode.anonymous);
      logger.info({ userId, anonymous: mode.anonymous }, 'Получен отзыв');
      await bot.sendMessage(chatId, t('feedback_thanks', lang));
      return;
    }
    pendingFeedback.delete(userId); // команда/вложение — отменяем режим отзыва
  }

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

  // Лимит бесплатного тарифа: если исчерпан — предлагаем оформить Pro.
  const usage = checkDailyLimit(userId);
  if (usage.exceeded) {
    const banner = promoBanner(lang);
    const text = t('limit_reached', lang, { limit: String(usage.limit) }) + (banner ? `\n\n${banner}` : '');
    await bot.sendMessage(
      chatId,
      text,
      billingEnabled() ? { reply_markup: upgradeKeyboard(lang) } : undefined,
    );
    return;
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

    // Голосовой ответ: всегда либо только в ответ на голосовое — по настройке юзера.
    // В голосовом режиме отправляем ТОЛЬКО голосовое (без дублирующего текста);
    // текст остаётся лишь запасным вариантом, если синтез не удался.
    const wasVoice = media.label === '[голосовое]';
    const wantVoice =
      isPro(userId) &&
      (user.voice_mode === 'always' || (user.voice_mode === 'reply' && wasVoice));
    let voiceSent = false;

    if (wantVoice) {
      try {
        await bot.sendChatAction(chatId, 'record_voice').catch(() => {});
        const ogg = await synthesizeVoice(reply);
        if (ogg) {
          await bot.sendVoice(chatId, ogg, {}, { filename: 'velora.ogg', contentType: 'audio/ogg' });
          voiceSent = true;
        }
      } catch (err) {
        logger.error({ err, userId }, 'Не удалось отправить голосовой ответ');
      }
    }

    if (!voiceSent) {
      await sendReply(bot, chatId, reply);
    }
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

    case '/upgrade':
    case '/pro': {
      await startUpgrade(bot, chatId, userId, lang);
      return;
    }

    case '/admin': {
      // Активация Pro бесплатно по паролю (для админов).
      if (arg && arg === config.adminPassword) {
        grantProUnlimited(userId, 'admin');
        await bot.sendMessage(chatId, t('admin_pro_granted', lang));
      } else {
        await bot.sendMessage(chatId, t('admin_denied', lang));
      }
      return;
    }

    case '/revoke': {
      // Админ сбрасывает Pro пользователю: /revoke <пароль> @username
      const parts = text.trim().split(/\s+/);
      const pass = parts[1];
      const uname = (parts[2] || '').replace(/^@/, '');
      if (pass !== config.adminPassword) {
        await bot.sendMessage(chatId, t('admin_denied', lang));
        return;
      }
      if (!uname) {
        await bot.sendMessage(chatId, t('revoke_usage', lang));
        return;
      }
      const target = usersRepo.findByUsername(uname);
      if (!target) {
        await bot.sendMessage(chatId, t('revoke_no_user', lang, { user: `@${uname}` }));
        return;
      }
      subscriptionsRepo.setStatus(target.user_id, 'cancelled');
      await bot.sendMessage(chatId, t('revoke_done', lang, { user: `@${uname}` }));
      bot.sendMessage(target.chat_id, t('pro_ended', target.language)).catch(() => {});
      return;
    }

    case '/cancel': {
      // Пользователь отменяет собственный Pro.
      if (getPlan(userId) !== 'pro') {
        await bot.sendMessage(chatId, t('cancel_none', lang));
        return;
      }
      subscriptionsRepo.setStatus(userId, 'cancelled');
      await bot.sendMessage(chatId, t('cancel_done', lang));
      return;
    }

    case '/feedback':
    case '/otziv': {
      // Пользователь оставляет отзыв: выбор аноним/с именем кнопками.
      await bot.sendMessage(chatId, t('feedback_choose', lang), {
        reply_markup: {
          inline_keyboard: [
            [{ text: t('feedback_btn_named', lang), callback_data: 'fb:named' }],
            [{ text: t('feedback_btn_anon', lang), callback_data: 'fb:anon' }],
          ],
        },
      });
      return;
    }

    case '/users': {
      // Список активных пользователей за 7 дней с их функциями: /users <пароль>
      if (arg !== config.adminPassword) {
        await bot.sendMessage(chatId, t('admin_denied', lang));
        return;
      }
      const since = Date.now() - 7 * 24 * 3600 * 1000;
      const rows = statsRepo.activeUsersDetailed(since, 30);
      if (rows.length === 0) {
        await bot.sendMessage(chatId, 'Активных пользователей за 7 дней нет.');
        return;
      }
      const lines = rows.map((r) => {
        const who = r.username ? `@${r.username}` : r.first_name || `id${r.user_id}`;
        const plan = getPlan(r.user_id) === 'pro' ? '⭐' : '🆓';
        const tt = statsRepo.topToolForUser(r.user_id, since);
        return `${plan} ${who} (${r.user_id}) — ${r.msgs} сообщ.${tt ? ` · ${tt.tool}` : ''}`;
      });
      await bot.sendMessage(chatId, `👥 Активные за 7 дней (${rows.length}):\n\n${lines.join('\n')}`);
      return;
    }

    case '/feedbacks': {
      // Чтение отзывов пользователей: /feedbacks <пароль>
      if (arg !== config.adminPassword) {
        await bot.sendMessage(chatId, t('admin_denied', lang));
        return;
      }
      const fbs = feedbackRepo.listRecent(25);
      if (fbs.length === 0) {
        await bot.sendMessage(chatId, 'Отзывов пока нет.');
        return;
      }
      const fmtDate = (e: number) =>
        new Intl.DateTimeFormat('ru-RU', { timeZone: config.timezone, dateStyle: 'short', timeStyle: 'short' }).format(e);
      const lines = fbs.map((f) => {
        const who = f.anonymous ? '🕶 аноним' : f.username ? `@${f.username}` : `id${f.user_id}`;
        return `${fmtDate(f.created_at)} · ${who}:\n${f.text}`;
      });
      await bot.sendMessage(chatId, `💬 Последние отзывы (${fbs.length}):\n\n${lines.join('\n\n')}`);
      return;
    }

    case '/stats': {
      // Админ-сводка метрик: /stats <пароль>
      if (arg !== config.adminPassword) {
        await bot.sendMessage(chatId, t('admin_denied', lang));
        return;
      }
      const now = Date.now();
      const day = now - 24 * 3600 * 1000;
      const week = now - 7 * 24 * 3600 * 1000;

      const total = statsRepo.totalUsers();
      const pro = statsRepo.activePro(now);
      const free = total - pro;
      const prompts = statsRepo.totalPrompts();
      const avg = total > 0 ? (prompts / total).toFixed(1) : '0';
      const conv = total > 0 ? ((pro / total) * 100).toFixed(1) : '0';

      const month = now - 30 * 24 * 3600 * 1000;
      const wau = statsRepo.activeUsersSince(week);
      const returning = statsRepo.returningUsers(now);
      const retention = wau > 0 ? ((returning / wau) * 100).toFixed(0) : '0';

      // Выручка: разбивка активных подписок по источнику.
      const subs = statsRepo.subsByProvider(now);
      const byProv = (p: string) => subs.find((s) => s.provider === p)?.n ?? 0;
      const paid = byProv('stars') + byProv('lemonsqueezy');
      const mrr = paid * config.proStarsPrice; // грубая оценка в звёздах/мес

      const text = [
        '📊 Статистика Velora',
        '',
        '— Пользователи —',
        `👥 Всего: ${total}`,
        `⭐ Pro активных: ${pro} (📈 конверсия ${conv}%)`,
        `🆓 Free: ${free}`,
        `🆕 Новых: ${statsRepo.newUsersSince(day)} за сутки · ${statsRepo.newUsersSince(week)} за 7д`,
        '',
        '— Вовлечённость —',
        `🔥 DAU: ${statsRepo.activeUsersSince(day)} · WAU: ${wau} · MAU: ${statsRepo.activeUsersSince(month)}`,
        `🔁 Возвращаются (7→7д): ${returning} (${retention}% от WAU)`,
        `💬 Запросов: ${prompts} всего · ${statsRepo.promptsSince(day)} за сутки · ${avg} на юзера`,
        '',
        '— Деньги —',
        `💳 Платных подписок: ${paid} (звёзды ${byProv('stars')} · карта ${byProv('lemonsqueezy')})`,
        `🎓 Админ-доступов: ${byProv('admin')}`,
        `📉 ~MRR: ${mrr} ⭐/мес`,
        '',
        `⏰ Отложенных отправок: ${statsRepo.pendingScheduled()}`,
        '',
        'Что используют — /usage ' + config.adminPassword,
      ].join('\n');

      await bot.sendMessage(chatId, text);
      return;
    }

    case '/usage': {
      // Что реально используют: топ инструментов, adoption интеграций, объекты.
      if (arg !== config.adminPassword) {
        await bot.sendMessage(chatId, t('admin_denied', lang));
        return;
      }
      const monthAgo = Date.now() - 30 * 24 * 3600 * 1000;
      const tools = statsRepo.topTools(monthAgo, 15);
      const adoption = statsRepo.integrationAdoption();
      const f = statsRepo.featureCounts();

      const toolLines = tools.length
        ? tools.map((x, i) => `${i + 1}. ${x.tool} — ${x.n}`).join('\n')
        : 'Пока нет данных (собирается с этого деплоя).';
      const adoptionLines = adoption.length
        ? adoption.map((x) => `• ${x.toolkit}: ${x.n}`).join('\n')
        : 'Никто ещё не подключил интеграции.';

      const text = [
        '🧩 Использование функций (30 дней)',
        '',
        '— Топ инструментов —',
        toolLines,
        '',
        '— Подключённые интеграции (юзеров) —',
        adoptionLines,
        '',
        '— Создано объектов —',
        `⏰ Напоминаний: ${f.reminders} · ✅ Задач: ${f.tasks}`,
        `📝 Заметок: ${f.notes} · 👥 Контактов: ${f.contacts}`,
      ].join('\n');

      await bot.sendMessage(chatId, text);
      return;
    }

    case '/stars': {
      // Баланс звёзд бота — только по админ-паролю (/stars <пароль>).
      if (arg !== config.adminPassword) {
        await bot.sendMessage(chatId, t('admin_denied', lang));
        return;
      }
      await bot.sendChatAction(chatId, 'typing').catch(() => {});
      const info = await fetchStarInfo();
      await bot.sendMessage(chatId, info);
      return;
    }

    case '/reset_stats': {
      // Обнуление статистики промптов и функций (пользователи и Pro сохраняются).
      if (arg !== config.adminPassword) {
        await bot.sendMessage(chatId, t('admin_denied', lang));
        return;
      }
      const r = maintenanceRepo.resetUsageStats();
      await bot.sendMessage(
        chatId,
        `✅ Статистика обнулена.\nУдалено: сообщений ${r.messages}, вызовов инструментов ${r.tools}.\nПользователи и Pro сохранены. (История диалогов тоже очищена.)`,
      );
      return;
    }

    case '/plan':
    case '/status': {
      if (getPlan(userId) === 'pro') {
        await bot.sendMessage(chatId, t('plan_pro', lang));
      } else {
        const usage = checkDailyLimit(userId);
        const banner = promoBanner(lang);
        const text =
          t('plan_free', lang, { used: String(usage.used), limit: String(usage.limit) }) +
          (banner ? `\n\n${banner}` : '');
        await bot.sendMessage(
          chatId,
          text,
          billingEnabled() ? { reply_markup: upgradeKeyboard(lang) } : undefined,
        );
      }
      return;
    }

    case '/voice': {
      // Голосовые ответы — функция Pro.
      if (billingEnabled() && !isPro(userId)) {
        await bot.sendMessage(chatId, t('voice_pro_only', lang), {
          reply_markup: upgradeKeyboard(lang),
        });
        return;
      }
      const choice = arg?.toLowerCase();
      if (choice === 'off' || choice === 'reply' || choice === 'always') {
        usersRepo.setVoiceMode(userId, choice);
        const key =
          choice === 'always' ? 'voice_on_always' : choice === 'reply' ? 'voice_on_reply' : 'voice_off';
        await bot.sendMessage(chatId, t(key, lang));
      } else {
        // Без аргумента — показываем кнопки выбора режима.
        await bot.sendMessage(chatId, t('voice_choose', lang), { reply_markup: voiceKeyboard(lang) });
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
      if (!composioRepo.listToolkits(userId).includes(app.slug) && !canConnectMore(userId)) {
        await bot.sendMessage(
          chatId,
          t('connect_limit', lang, { limit: String(config.freeMaxIntegrations) }),
          billingEnabled() ? { reply_markup: upgradeKeyboard(lang) } : undefined,
        );
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

    case '/disconnect_all': {
      const toolkits = composioRepo.listToolkits(userId);
      if (toolkits.length === 0) {
        await bot.sendMessage(chatId, t('connections_empty', lang));
        return;
      }
      await disconnectAllApps(userId);
      await bot.sendMessage(chatId, t('disconnected_all', lang));
      return;
    }

    case '/disconnect': {
      // С аргументом «all» — отключаем всё.
      if (arg && ['all', 'все', 'всё'].includes(arg.toLowerCase())) {
        await disconnectAllApps(userId);
        await bot.sendMessage(chatId, t('disconnected_all', lang));
        return;
      }
      // С аргументом-приложением — отвязываем конкретное.
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
        reply_markup: disconnectKeyboard(userId, lang),
      });
      return;
    }

    default:
      // Неизвестная команда — подсказываем помощь.
      await bot.sendMessage(chatId, t('help', lang));
      return;
  }
}
