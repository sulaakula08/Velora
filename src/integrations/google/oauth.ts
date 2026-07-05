import { google } from 'googleapis';
import { config } from '../../config';
import { googleTokensRepo } from '../../db/repositories';
import { logger } from '../../logger';

/** Права доступа: события календаря + чтение и отправка почты. */
export const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
];

/** Настроена ли интеграция (заданы ли client id/secret). */
export function isGoogleConfigured(): boolean {
  return Boolean(config.googleClientId && config.googleClientSecret);
}

export function createOAuthClient() {
  return new google.auth.OAuth2(
    config.googleClientId,
    config.googleClientSecret,
    config.googleRedirectUri,
  );
}

/** Тип авторизованного клиента Google для передачи в API. */
export type GoogleClient = ReturnType<typeof createOAuthClient>;

/** Ссылка авторизации: offline + prompt=consent, чтобы получить refresh_token. */
export function buildAuthUrl(state: string): string {
  return createOAuthClient().generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: GOOGLE_SCOPES,
    state,
  });
}

/** Обмен кода авторизации на токены (вызывается из callback-сервера). */
export async function exchangeCode(code: string): Promise<string> {
  const client = createOAuthClient();
  const { tokens } = await client.getToken(code);
  return JSON.stringify(tokens);
}

/**
 * Возвращает авторизованный клиент Google для пользователя или null, если он
 * не подключил Google. Автоматически сохраняет обновлённые токены (refresh).
 */
export function getUserClient(userId: number): GoogleClient | null {
  const stored = googleTokensRepo.get(userId);
  if (!stored) return null;

  const client = createOAuthClient();
  const credentials = JSON.parse(stored);
  client.setCredentials(credentials);

  client.on('tokens', (fresh) => {
    // refresh_token приходит не всегда — сохраняем, объединяя со старыми токенами.
    const merged = { ...credentials, ...fresh };
    googleTokensRepo.save(userId, JSON.stringify(merged));
    logger.info({ userId }, 'Токены Google обновлены');
  });

  return client;
}
