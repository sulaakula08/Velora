import crypto from 'crypto';
import type { IncomingMessage } from 'http';
import { registerRoute } from '../http/server';
import { subscriptionsRepo } from '../db/repositories';
import { config } from '../config';
import { logger } from '../logger';

/** Читает тело запроса целиком (нужно «сырое» для проверки подписи). */
function readRawBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** Проверка подписи webhook LemonSqueezy (HMAC-SHA256 от сырого тела). */
function verifySignature(raw: string, signature: string | undefined): boolean {
  if (!signature) return false;
  const digest = crypto.createHmac('sha256', config.lemonWebhookSecret).update(raw).digest('hex');
  const a = Buffer.from(digest, 'hex');
  const b = Buffer.from(signature, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Достаёт telegram_id из custom-данных чекаута. */
function telegramIdFrom(payload: any): number | null {
  const custom = payload?.meta?.custom_data ?? {};
  const raw = custom.telegram_id ?? custom.telegramId;
  const id = Number(raw);
  return Number.isFinite(id) && id > 0 ? id : null;
}

// Событие → активировать или снять Pro.
const ACTIVATE = new Set([
  'subscription_created',
  'subscription_updated',
  'subscription_resumed',
  'subscription_unpaused',
  'subscription_payment_success',
  'order_created',
]);
const DEACTIVATE = new Set([
  'subscription_cancelled',
  'subscription_expired',
  'subscription_paused',
]);

/**
 * Регистрирует webhook LemonSqueezy: /billing/lemonsqueezy/webhook.
 * onChange уведомляет пользователя (например, «Pro активирован»).
 */
export function registerBillingRoutes(
  onChange?: (userId: number, active: boolean) => void,
): void {
  registerRoute('/billing/lemonsqueezy/webhook', async (_url, res, req) => {
    if (req.method !== 'POST') {
      res.writeHead(405);
      res.end();
      return;
    }

    const raw = await readRawBody(req);
    const signature = req.headers['x-signature'] as string | undefined;
    if (!verifySignature(raw, signature)) {
      logger.warn('LemonSqueezy: неверная подпись webhook');
      res.writeHead(401);
      res.end();
      return;
    }

    let payload: any;
    try {
      payload = JSON.parse(raw);
    } catch {
      res.writeHead(400);
      res.end();
      return;
    }

    const event: string = payload?.meta?.event_name ?? '';
    const userId = telegramIdFrom(payload);
    // Отвечаем 200 в любом случае, чтобы LemonSqueezy не ретраил бесконечно.
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');

    if (!userId) {
      logger.warn({ event }, 'LemonSqueezy: в webhook нет telegram_id');
      return;
    }

    const attrs = payload?.data?.attributes ?? {};
    const ref = String(payload?.data?.id ?? '');

    if (ACTIVATE.has(event) && attrs.status !== 'expired' && attrs.status !== 'cancelled') {
      const renews = attrs.renews_at ?? attrs.ends_at;
      const periodEnd = renews ? new Date(renews).getTime() : null;
      subscriptionsRepo.activate(userId, { periodEnd, provider: 'lemonsqueezy', ref });
      logger.info({ userId, event }, 'Pro активирован');
      onChange?.(userId, true);
    } else if (DEACTIVATE.has(event)) {
      subscriptionsRepo.setStatus(userId, event === 'subscription_expired' ? 'expired' : 'cancelled');
      logger.info({ userId, event }, 'Pro снят');
      onChange?.(userId, false);
    }
  });

  logger.info('Webhook биллинга зарегистрирован: /billing/lemonsqueezy/webhook');
}
