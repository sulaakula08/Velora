import { randomUUID } from 'crypto';
import { composio, authConfigFor } from './client';
import { registerRoute, htmlPage } from '../../http/server';
import { composioRepo } from '../../db/repositories';
import { config } from '../../config';
import { logger } from '../../logger';

const pending = new Map<string, { userId: number; toolkit: string }>();

export type ConnectResult =
  | { url: string } // нужно пройти авторизацию по ссылке
  | { alreadyConnected: true } // уже подключено, ссылка не нужна
  | null; // для тулкита не задан auth-конфиг

/**
 * Инициирует подключение тулкита для пользователя через Composio.
 * Возвращает ссылку авторизации, признак «уже подключено», либо null (нет
 * auth-конфига). Перед подключением подчищает дубли/протухшие аккаунты, иначе
 * link() падает с MULTIPLE_CONNECTED_ACCOUNTS.
 */
export async function startConnect(userId: number, toolkit: string): Promise<ConnectResult> {
  const authConfigId = authConfigFor(toolkit);
  if (!authConfigId) return null;

  // Разбираемся с уже существующими подключениями этого тулкита.
  try {
    const list: any = await (composio() as any).connectedAccounts.list({
      userIds: [String(userId)],
    });
    const items: any[] = list?.items ?? (Array.isArray(list) ? list : []);
    const forToolkit = items.filter((a) => (a.toolkit?.slug ?? a.toolkitSlug) === toolkit);
    const active = forToolkit.filter((a) => a.status === 'ACTIVE');

    if (active.length > 0) {
      // Уже подключено — удаляем лишние дубли, оставляем один активный аккаунт.
      for (const a of forToolkit) {
        if (a.id !== active[0].id) {
          await (composio() as any).connectedAccounts.delete(a.id).catch(() => {});
        }
      }
      composioRepo.add(userId, toolkit);
      return { alreadyConnected: true };
    }

    // Активных нет (протухли/не завершены) — сносим всё, чтобы переподключить начисто.
    for (const a of forToolkit) {
      await (composio() as any).connectedAccounts.delete(a.id).catch(() => {});
    }
  } catch (err) {
    logger.warn({ err, toolkit }, 'Не удалось проверить/очистить старые подключения Composio');
  }

  const state = randomUUID();
  pending.set(state, { userId, toolkit });
  setTimeout(() => pending.delete(state), 10 * 60 * 1000).unref();

  const callbackUrl = `${config.composioCallbackBaseUrl}/composio/callback?state=${state}`;
  // Composio-managed OAuth: link() сразу возвращает redirectUrl.
  const request: any = await (composio() as any).connectedAccounts.link(
    String(userId),
    authConfigId,
    { callbackUrl },
  );
  const url = request?.redirectUrl;
  return url ? { url } : null;
}

/**
 * Отвязывает тулкит: отзывает доступ на стороне Composio (удаляет все
 * connected-аккаунты этого тулкита) и убирает запись из локальной БД.
 * Возвращает false, только если записи не было изначально.
 */
export async function disconnectApp(userId: number, toolkit: string): Promise<boolean> {
  const had = composioRepo.listToolkits(userId).includes(toolkit);

  try {
    const list: any = await (composio() as any).connectedAccounts.list({
      userIds: [String(userId)],
    });
    const items: any[] = list?.items ?? (Array.isArray(list) ? list : []);
    const forToolkit = items.filter((a) => (a.toolkit?.slug ?? a.toolkitSlug) === toolkit);
    for (const a of forToolkit) {
      await (composio() as any).connectedAccounts.delete(a.id).catch(() => {});
    }
  } catch (err) {
    logger.warn({ err, toolkit }, 'Не удалось отозвать доступ Composio при отвязке');
  }

  composioRepo.remove(userId, toolkit);
  return had;
}

/** Регистрирует маршрут callback Composio на общем HTTP-сервере. */
export function registerComposioRoutes(onConnect: (userId: number, toolkit: string) => void): void {
  registerRoute('/composio/callback', (url, res) => {
    const state = url.searchParams.get('state');
    const status = url.searchParams.get('status');
    const entry = state ? pending.get(state) : undefined;

    // Composio возвращает status=success; иногда параметр может отсутствовать.
    const ok = entry && status !== 'error' && status !== 'failed';
    if (!ok || !entry) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(htmlPage('Не удалось подключить приложение. Попробуй ещё раз.'));
      return;
    }

    try {
      composioRepo.add(entry.userId, entry.toolkit);
      pending.delete(state!);
      onConnect(entry.userId, entry.toolkit);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(htmlPage('Готово! Приложение подключено к Velora ✅ Вернись в Telegram.'));
    } catch (err) {
      logger.error({ err }, 'Ошибка сохранения подключения Composio');
      res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(htmlPage('Что-то пошло не так. Попробуй ещё раз.'));
    }
  });
}
