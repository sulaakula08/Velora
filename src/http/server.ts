import http from 'http';
import { config } from '../config';
import { logger } from '../logger';

export type RouteHandler = (
  url: URL,
  res: http.ServerResponse,
  req: http.IncomingMessage,
) => Promise<void> | void;

const routes = new Map<string, RouteHandler>();
let server: http.Server | null = null;

/** Регистрирует обработчик для пути (например, /oauth/callback, /composio/callback). */
export function registerRoute(pathname: string, handler: RouteHandler): void {
  routes.set(pathname, handler);
}

export function htmlPage(msg: string): string {
  return (
    `<!doctype html><meta charset="utf-8"><body style="font-family:sans-serif;text-align:center;padding:60px">` +
    `<h2>${msg}</h2></body>`
  );
}

/** Запускает единый HTTP-сервер (идемпотентно). Используется для OAuth-callback'ов интеграций. */
export function startHttpServer(): http.Server {
  if (server) return server;

  server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://localhost:${config.oauthPort}`);
    const handler = routes.get(url.pathname);
    if (!handler) {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(htmlPage('Не найдено'));
      return;
    }
    try {
      await handler(url, res, req);
    } catch (err) {
      logger.error({ err, path: url.pathname }, 'Ошибка обработки HTTP-запроса');
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(htmlPage('Внутренняя ошибка. Попробуй ещё раз.'));
      }
    }
  });

  server.listen(config.oauthPort, () => {
    logger.info({ port: config.oauthPort }, 'HTTP-сервер интеграций запущен');
  });

  return server;
}
