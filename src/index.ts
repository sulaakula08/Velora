import { logger } from './logger';
import { initDb } from './db/db';
import { createBot } from './bot/bot';
import { startScheduler } from './scheduler/scheduler';
import { usersRepo } from './db/repositories';
import { t } from './i18n/i18n';
import { startHttpServer } from './http/server';
import { isGoogleConfigured } from './integrations/google/oauth';
import { registerGoogleRoutes } from './integrations/google/server';
import { isComposioConfigured, SUPPORTED_APPS, loadAuthConfigs } from './integrations/composio/client';
import { registerComposioRoutes } from './integrations/composio/connect';
import { billingEnabled } from './billing/plans';
import { registerBillingRoutes } from './billing/lemonsqueezy';

function main(): void {
  logger.info('Запуск Velora…');

  initDb();
  const bot = createBot();
  startScheduler(bot);

  const notify = (userId: number, text: string) => {
    const user = usersRepo.get(userId);
    if (user) {
      bot.sendMessage(user.chat_id, text).catch((err) => logger.error({ err }, 'Уведомление'));
    }
  };

  const googleOn = isGoogleConfigured();
  const composioOn = isComposioConfigured();
  const billingOn = billingEnabled();

  // Биллинг (подписка Pro) через LemonSqueezy.
  if (billingOn) {
    registerBillingRoutes((userId, active) => {
      const user = usersRepo.get(userId);
      if (user) notify(userId, t(active ? 'pro_activated' : 'pro_ended', user.language));
    });
  }

  // Собственный OAuth Google (Calendar + Gmail).
  if (googleOn) {
    registerGoogleRoutes((userId) => {
      const user = usersRepo.get(userId);
      if (user) notify(userId, t('google_connected', user.language));
    });
  }

  // Composio — универсальные интеграции.
  if (composioOn) {
    // Подтягиваем auth-конфиги из Composio (Sheets, Canva и всё включённое)
    // без ручного COMPOSIO_AUTH_CONFIGS. Обновляем и периодически.
    void loadAuthConfigs();
    setInterval(() => void loadAuthConfigs(), 30 * 60 * 1000).unref();

    registerComposioRoutes((userId, toolkit) => {
      const user = usersRepo.get(userId);
      const appName = SUPPORTED_APPS.find((a) => a.slug === toolkit)?.name ?? toolkit;
      if (user) notify(userId, t('connected', user.language, { app: appName }));
    });
  }

  // Единый HTTP-сервер для callback'ов интеграций и webhook'ов биллинга.
  if (googleOn || composioOn || billingOn) {
    startHttpServer();
  } else {
    logger.info('Интеграции и биллинг выключены');
  }

  logger.info('Velora готова к работе. Напиши боту в Telegram.');
}

// Глобальные страховки: логируем и продолжаем работу, не роняя процесс.
process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, 'Необработанное отклонение промиса');
});
process.on('uncaughtException', (err) => {
  logger.error({ err }, 'Необработанное исключение');
});

try {
  main();
} catch (err) {
  logger.error({ err }, 'Не удалось запустить приложение');
  process.exit(1);
}
