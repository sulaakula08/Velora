import { exchangeCode } from './oauth';
import { googleTokensRepo } from '../../db/repositories';
import { registerRoute, htmlPage } from '../../http/server';
import { logger } from '../../logger';

// Соответствие state → userId для защиты от CSRF и привязки callback к пользователю.
const pendingStates = new Map<string, number>();

/** Регистрирует ожидание авторизации (вызывается при /connect_google). */
export function registerOAuthState(state: string, userId: number): void {
  pendingStates.set(state, userId);
  setTimeout(() => pendingStates.delete(state), 10 * 60 * 1000).unref();
}

/**
 * Регистрирует маршрут OAuth-callback Google на общем HTTP-сервере.
 * onConnect вызывается после успешного подключения (чтобы уведомить пользователя).
 */
export function registerGoogleRoutes(onConnect: (userId: number) => void): void {
  registerRoute('/oauth/callback', async (url, res) => {
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const userId = state ? pendingStates.get(state) : undefined;

    if (!code || !state || userId === undefined) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(htmlPage('Некорректный или устаревший запрос. Попробуй /connect_google ещё раз.'));
      return;
    }

    try {
      const tokens = await exchangeCode(code);
      googleTokensRepo.save(userId, tokens);
      pendingStates.delete(state);
      onConnect(userId);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(htmlPage('Готово! Google подключён к Velora ✅ Можешь вернуться в Telegram.'));
    } catch (err) {
      logger.error({ err }, 'Ошибка обмена кода Google');
      res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(htmlPage('Не удалось подключить Google. Попробуй ещё раз.'));
    }
  });
}
