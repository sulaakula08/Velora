import ru from '../locales/ru.json';
import kk from '../locales/kk.json';

export type Lang = 'ru' | 'kk';

const catalogs: Record<Lang, Record<string, string>> = { ru, kk };

export type LocaleKey = keyof typeof ru;

/**
 * Возвращает строку интерфейса для нужного языка с подстановкой переменных вида {name}.
 * Если ключ или язык отсутствует — откатывается к русскому, затем к самому ключу.
 */
export function t(key: LocaleKey, lang: Lang, vars: Record<string, string> = {}): string {
  const template = catalogs[lang]?.[key] ?? catalogs.ru[key] ?? String(key);
  return template.replace(/\{(\w+)\}/g, (_, name) => vars[name] ?? `{${name}}`);
}

// Символы, уникальные для казахского алфавита (нет в русском).
const KAZAKH_SPECIFIC = /[әғқңөұүһі]/i;

/**
 * Простое эвристическое определение языка интерфейса по тексту сообщения.
 * Нужно только для служебных строк бота — ответы LLM формирует сам Gemini
 * на языке последнего сообщения пользователя (см. системный промпт).
 */
export function detectLang(text: string): Lang | null {
  if (KAZAKH_SPECIFIC.test(text)) return 'kk';
  // Есть кириллица, но нет казахских букв — считаем русским.
  if (/[а-яё]/i.test(text)) return 'ru';
  // Латиница/цифры/эмодзи — язык не определён, не трогаем сохранённый.
  return null;
}
