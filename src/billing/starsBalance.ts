import { config } from '../config';
import { logger } from '../logger';

/** Вызов метода Bot API напрямую (для методов, которых нет в библиотеке). */
async function tg(method: string, params: Record<string, any> = {}): Promise<any> {
  const res = await fetch(`https://api.telegram.org/bot${config.telegramToken}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params),
  });
  const json: any = await res.json();
  if (!json.ok) throw new Error(json.description || `ошибка ${method}`);
  return json.result;
}

function fmtDate(unixSec: number): string {
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: config.timezone,
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(new Date(unixSec * 1000));
}

/**
 * Возвращает текст с балансом звёзд бота и последними транзакциями.
 * Использует getMyStarBalance (если доступен) и getStarTransactions.
 */
export async function fetchStarInfo(): Promise<string> {
  try {
    // Баланс: пробуем прямой метод, иначе считаем из транзакций.
    let balance: number | null = null;
    try {
      const bal = await tg('getMyStarBalance');
      balance = bal?.amount ?? bal?.star_amount ?? null;
    } catch {
      /* метод может быть недоступен — посчитаем ниже */
    }

    const txResult = await tg('getStarTransactions', { limit: 10 });
    const transactions: any[] = txResult?.transactions ?? [];

    if (balance == null) {
      // Грубая оценка: входящие минус исходящие по доступным транзакциям.
      balance = transactions.reduce((sum, t) => sum + (t.source ? t.amount : -t.amount), 0);
    }

    const lines = transactions.slice(0, 8).map((t) => {
      const incoming = Boolean(t.source);
      const sign = incoming ? '+' : '−';
      return `${sign}${t.amount} ⭐ · ${fmtDate(t.date)}`;
    });

    const body = lines.length ? lines.join('\n') : 'Пока нет операций.';
    return `⭐ Баланс бота: ${balance} звёзд\n\nПоследние операции:\n${body}`;
  } catch (err) {
    logger.error({ err }, 'Не удалось получить баланс звёзд');
    return 'Не удалось получить баланс звёзд. Попробуй чуть позже.';
  }
}
