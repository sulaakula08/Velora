import type { Tool } from './types';
import { getUserClient } from '../integrations/google/oauth';
import { listEvents, createEvent } from '../integrations/google/calendar';

const NOT_CONNECTED =
  'Google не подключён. Скажи пользователю выполнить команду /connect_google, чтобы дать доступ к календарю.';

function fmt(iso: string, tz: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat('ru-RU', { timeZone: tz, dateStyle: 'medium', timeStyle: 'short' }).format(d);
}

export const createCalendarEventTool: Tool = {
  name: 'create_calendar_event',
  description:
    'Создать событие в Google Календаре пользователя. Время указывай в ISO 8601 со смещением +05:00 ' +
    '(Asia/Almaty). Если конец не указан — не заполняй end, событие будет на 1 час. Требует подключённого Google.',
  input_schema: {
    type: 'object',
    properties: {
      summary: { type: 'string', description: 'Название события.' },
      start: { type: 'string', description: 'Начало, ISO 8601 +05:00, например 2026-07-06T15:00:00+05:00.' },
      end: { type: 'string', description: 'Конец, ISO 8601 +05:00 (необязательно).' },
      description: { type: 'string', description: 'Описание/заметки к событию (необязательно).' },
    },
    required: ['summary', 'start'],
  },
  async execute(input, ctx) {
    const client = getUserClient(ctx.userId);
    if (!client) return NOT_CONNECTED;

    const startDate = new Date(input.start);
    if (Number.isNaN(startDate.getTime())) return 'Ошибка: не удалось разобрать время start.';
    const end = input.end || new Date(startDate.getTime() + 60 * 60 * 1000).toISOString();

    try {
      await createEvent(client, {
        summary: input.summary,
        start: input.start,
        end,
        description: input.description,
      });
      return `Создал событие «${input.summary}» на ${fmt(input.start, ctx.timezone)}.`;
    } catch (err) {
      return `Не удалось создать событие: ${err instanceof Error ? err.message : 'ошибка Google'}.`;
    }
  },
};

export const listCalendarEventsTool: Tool = {
  name: 'list_calendar_events',
  description:
    'Показать ближайшие события из Google Календаря. По умолчанию — на неделю вперёд. Требует подключённого Google.',
  input_schema: {
    type: 'object',
    properties: {
      time_min: { type: 'string', description: 'Начало интервала, ISO 8601 (необязательно).' },
      time_max: { type: 'string', description: 'Конец интервала, ISO 8601 (необязательно).' },
    },
  },
  async execute(input, ctx) {
    const client = getUserClient(ctx.userId);
    if (!client) return NOT_CONNECTED;

    const now = new Date();
    const timeMin = input.time_min || now.toISOString();
    const timeMax = input.time_max || new Date(now.getTime() + 7 * 24 * 3600 * 1000).toISOString();

    try {
      const events = await listEvents(client, timeMin, timeMax);
      if (events.length === 0) return 'В этом интервале событий нет.';
      return events.map((e) => `• ${fmt(e.start, ctx.timezone)} — ${e.summary}`).join('\n');
    } catch (err) {
      return `Не удалось получить события: ${err instanceof Error ? err.message : 'ошибка Google'}.`;
    }
  },
};
