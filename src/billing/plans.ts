import { config } from '../config';
import { subscriptionsRepo, messagesRepo, composioRepo } from '../db/repositories';

export type Plan = 'free' | 'pro';

/** Настроена ли оплата через LemonSqueezy (внешний чекаут картой). */
export function lemonEnabled(): boolean {
  return Boolean(config.lemonWebhookSecret && config.lemonCheckoutUrl);
}

/** Включена ли оплата Telegram Stars (внутри бота). */
export function starsEnabled(): boolean {
  return config.proStarsEnabled && config.proStarsPrice > 0;
}

/** Активна ли промо-скидка на Pro. */
export function promoActive(): boolean {
  return config.proStarsPromo > 0 && config.proStarsPromo < config.proStarsPrice;
}

/** Фактическая цена Pro в звёздах с учётом акции. */
export function proStarsAmount(): number {
  return promoActive() ? config.proStarsPromo : config.proStarsPrice;
}

export type BillingPeriod = 'month' | 'year';

/** Цена в звёздах для выбранного периода (месяц учитывает промо). */
export function priceFor(period: BillingPeriod): number {
  return period === 'year' ? config.proStarsPriceYear : proStarsAmount();
}

/** На сколько дней даёт Pro выбранный период. */
export function daysFor(period: BillingPeriod): number {
  return period === 'year' ? config.proDurationDaysYear : config.proDurationDays;
}

/**
 * Включён ли биллинг хоть каким-то способом. Если нет — гейтинг ВЫКЛЮЧЕН: все
 * функции доступны без ограничений (режим до монетизации).
 */
export function billingEnabled(): boolean {
  return starsEnabled() || lemonEnabled();
}

/** Выдаёт Pro на N дней (продлевает от текущего конца периода, если он в будущем). */
export function grantProDays(userId: number, days: number, provider: string, ref: string | null): void {
  const current = subscriptionsRepo.get(userId);
  const base =
    current && current.status === 'active' && current.current_period_end && current.current_period_end > Date.now()
      ? current.current_period_end
      : Date.now();
  const periodEnd = base + days * 24 * 60 * 60 * 1000;
  subscriptionsRepo.activate(userId, { periodEnd, provider, ref });
}

/** Выдаёт Pro без срока (для админов). */
export function grantProUnlimited(userId: number, provider: string): void {
  subscriptionsRepo.activate(userId, { periodEnd: null, provider, ref: null });
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
