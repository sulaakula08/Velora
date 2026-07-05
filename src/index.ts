import { logger } from './logger';
import { initDb } from './db/db';
import { createBot } from './bot/bot';
import { startScheduler } from './scheduler/scheduler';
import { usersRepo } from './db/repositories';
import { t } from './i18n/i18n';
import { startHttpServer } from './http/server';
import { isGoogleConfigured } from './integrations/google/oauth';
import { registerGoogleRoutes } from './integrations/google/server';
import { isComposioConfigured, SUPPORTED_APPS } from './integrations/composio/client';
import { registerComposioRoutes } from './integrations/composio/connect';

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

  // Собственный OAuth Google (Calendar + Gmail).
  if (googleOn) {
    registerGoogleRoutes((userId) => {
      const user = usersRepo.get(userId);
      if (user) notify(userId, t('google_connected', user.language));
    });
  }

  // Composio — универсальные интеграции.
  if (composioOn) {
    registerComposioRoutes((userId, toolkit) => {
      const user = usersRepo.get(userId);
      const appName = SUPPORTED_APPS.find((a) => a.slug === toolkit)?.name ?? toolkit;
      if (user) notify(userId, t('connected', user.language, { app: appName }));
    });
  }

  // Единый HTTP-сервер для callback'ов — только если есть хотя бы одна интеграция.
  if (googleOn || composioOn) {
    startHttpServer();
  } else {
    logger.info('Интеграции выключены (нет GOOGLE_* и COMPOSIO_API_KEY)');
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
