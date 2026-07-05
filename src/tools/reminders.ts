import type { Tool } from './types';
import { remindersRepo } from '../db/repositories';

function formatInTz(epoch: number, timezone: string): string {
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: timezone,
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(epoch));
}

export const createReminderTool: Tool = {
  name: 'create_reminder',
  description:
    'Создать напоминание на конкретное время. Вызывай, когда пользователь просит напомнить о деле ' +
    '(«напомни завтра в 18:00 позвонить маме»). Время remind_at рассчитай сам, исходя из текущей даты ' +
    'и времени из системного промпта, и передай в формате ISO 8601 со смещением +05:00 (Asia/Almaty), ' +
    'например 2026-07-05T18:00:00+05:00.',
  input_schema: {
    type: 'object',
    properties: {
      text: {
        type: 'string',
        description: 'О чём напомнить, короткой фразой (например, «позвонить маме»).',
      },
      remind_at: {
        type: 'string',
        description: 'Дата и время напоминания в ISO 8601 со смещением, например 2026-07-05T18:00:00+05:00.',
      },
    },
    required: ['text', 'remind_at'],
  },
  async execute(input, ctx) {
    const at = new Date(input.remind_at);
    if (Number.isNaN(at.getTime())) {
      return 'Ошибка: не удалось разобрать время remind_at. Нужен формат ISO 8601, например 2026-07-05T18:00:00+05:00.';
    }
    remindersRepo.create(ctx.userId, ctx.chatId, input.text, at.getTime());
    const human = formatInTz(at.getTime(), ctx.timezone);
    const past = at.getTime() < Date.now() ? ' (внимание: время уже в прошлом)' : '';
    return `Напоминание сохранено: «${input.text}» на ${human}${past}.`;
  },
};

export const listRemindersTool: Tool = {
  name: 'list_reminders',
  description:
    'Показать активные (ещё не сработавшие) напоминания пользователя. Вызывай на вопросы вроде ' +
    '«какие у меня напоминания?», «что я просил напомнить?».',
  input_schema: {
    type: 'object',
    properties: {},
  },
  async execute(_input, ctx) {
    const items = remindersRepo.listPending(ctx.userId);
    if (items.length === 0) return 'Активных напоминаний нет.';
    return items
      .map((r, i) => `${i + 1}. ${formatInTz(r.remind_at, ctx.timezone)} — ${r.text}`)
      .join('\n');
  },
};
