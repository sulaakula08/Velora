import 'dotenv/config';

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new Error(
      `Не задана переменная окружения ${name}. ` +
        `Скопируйте .env.example в .env и заполните значения (см. README.md).`,
    );
  }
  return value.trim();
}

export const config = {
  telegramToken: required('TELEGRAM_BOT_TOKEN'),
  geminiApiKey: required('GEMINI_API_KEY'),
  model: process.env.GEMINI_MODEL?.trim() || 'gemini-2.5-flash',
  historyLimit: parseInt(process.env.HISTORY_LIMIT || '20', 10),
  timezone: process.env.TIMEZONE?.trim() || 'Asia/Almaty',
  dbPath: process.env.DB_PATH?.trim() || './velora.db',
  logLevel: process.env.LOG_LEVEL?.trim() || 'info',
  // Отключает проверку TLS-сертификата (обход перехвата трафика антивирусом/VPN
  // при локальной отладке). Небезопасно — не для продакшна.
  telegramInsecureTls: process.env.TELEGRAM_ALLOW_INSECURE_TLS === 'true',
  // Показывать реальный текст ошибки прямо в ответе бота (для отладки).
  debugErrors: process.env.DEBUG_ERRORS === 'true',
  // Google OAuth (Calendar + Gmail). Если не заданы — интеграция просто выключена.
  googleClientId: process.env.GOOGLE_CLIENT_ID?.trim() || '',
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET?.trim() || '',
  googleRedirectUri:
    process.env.GOOGLE_REDIRECT_URI?.trim() || 'http://localhost:3000/oauth/callback',
  // Порт HTTP-сервера интеграций. Облачные платформы (Railway/Render/Fly) задают
  // порт через PORT — берём его в приоритете, иначе OAUTH_PORT, иначе 3000.
  oauthPort: parseInt(process.env.PORT || process.env.OAUTH_PORT || '3000', 10),
  // Composio — универсальные интеграции (Gmail, Календарь, Slack, Notion... по одному ключу).
  composioApiKey: process.env.COMPOSIO_API_KEY?.trim() || '',
  composioCallbackBaseUrl:
    process.env.COMPOSIO_CALLBACK_BASE_URL?.trim() ||
    `http://localhost:${parseInt(process.env.OAUTH_PORT || '3000', 10)}`,
  // JSON-карта: slug тулкита → id auth-конфига из дашборда Composio, напр.
  // {"gmail":"ac_...","googlecalendar":"ac_..."}
  composioAuthConfigs: parseJsonMap(process.env.COMPOSIO_AUTH_CONFIGS),
} as const;

function parseJsonMap(raw?: string): Record<string, string> {
  if (!raw || raw.trim() === '') return {};
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

// Если включён обход TLS — распространяем его на весь исходящий трафик процесса
// (в т.ч. запросы к Gemini через global fetch/undici), не только на Telegram.
if (config.telegramInsecureTls) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}
