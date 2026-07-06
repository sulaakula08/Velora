import { config } from '../config';
import { subscriptionsRepo, messagesRepo, composioRepo } from '../db/repositories';

export type Plan = 'free' | 'pro';

/**
 * Включён ли биллинг. Если webhook-secret не задан — гейтинг ВЫКЛЮЧЕН: все
 * функции доступны без ограничений (режим до монетизации), чтобы не резать
 * существующих пользователей до запуска оплаты.
 */
export function billingEnabled(): boolean {
  return Boolean(config.lemonWebhookSecret && config.lemonCheckoutUrl);
}

/** Текущий тариф пользователя. Если биллинг выключен — всегда 'pro'. */
export function getPlan(userId: number): Plan {
  if (!billingEnabled()) return 'pro';
  const sub = subscriptionsRepo.get(userId);
  if (!sub || sub.status !== 'active') return 'free';
  if (sub.current_period_end != null && sub.current_period_end < Date.now()) return 'free';
  return 'pro';
}

export function isPro(userId: number): boolean {
  return getPlan(userId) === 'pro';
}

/** Начало текущих суток в часовом поясе (эпоха, мс). */
function startOfTodayEpoch(): number {
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: config.timezone }).format(new Date());
  return new Date(`${date}T00:00:00+05:00`).getTime();
}

export interface DailyUsage {
  used: number;
  limit: number;
  exceeded: boolean;
}

/** Проверка суточного лимита сообщений для free-тарифа. */
export function checkDailyLimit(userId: number): DailyUsage {
  const limit = config.freeDailyMessages;
  if (isPro(userId)) return { used: 0, limit, exceeded: false };
  const used = messagesRepo.countUserSince(userId, startOfTodayEpoch());
  return { used, limit, exceeded: used >= limit };
}

/** Может ли пользователь подключить ещё одну интеграцию (лимит на free). */
export function canConnectMore(userId: number): boolean {
  if (isPro(userId)) return true;
  return composioRepo.count(userId) < config.freeMaxIntegrations;
}

/** Ссылка на оплату Pro с привязкой к Telegram-аккаунту (для webhook). */
export function checkoutUrlFor(userId: number): string {
  const base = config.lemonCheckoutUrl;
  const sep = base.includes('?') ? '&' : '?';
  return `${base}${sep}checkout[custom][telegram_id]=${userId}`;
}
