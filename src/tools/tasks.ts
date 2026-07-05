import type { Tool } from './types';
import { tasksRepo } from '../db/repositories';

function parseIso(value?: string): number | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}

function formatDate(epoch: number, timezone: string): string {
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: timezone,
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(epoch));
}

export const addTaskTool: Tool = {
  name: 'add_task',
  description:
    'Добавить дело в список задач (в отличие от напоминания, у задачи есть статус сделал/не сделал). ' +
    'Если у дела есть срок — укажи due_at (ISO 8601 со смещением +05:00). Если это дело, про которое ' +
    'стоит переспросить позже (позвонить, написать, узнать, отправить) — укажи follow_up_at (ISO 8601 +05:00): ' +
    'тогда бот сам напомнит и переспросит, выполнено ли оно.',
  input_schema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Суть дела короткой фразой.' },
      due_at: {
        type: 'string',
        description: 'Срок выполнения в ISO 8601 +05:00 (если есть), например 2026-07-06T12:00:00+05:00.',
      },
      follow_up_at: {
        type: 'string',
        description: 'Когда бот должен переспросить о выполнении, ISO 8601 +05:00 (если уместно).',
      },
    },
    required: ['title'],
  },
  async execute(input, ctx) {
    const dueAt = parseIso(input.due_at);
    const followUpAt = parseIso(input.follow_up_at);
    tasksRepo.add(ctx.userId, ctx.chatId, input.title, dueAt, followUpAt);
    const when = dueAt ? ` (срок: ${formatDate(dueAt, ctx.timezone)})` : '';
    return `Добавил задачу: «${input.title}»${when}.`;
  },
};

export const listTasksTool: Tool = {
  name: 'list_tasks',
  description: 'Показать открытые (невыполненные) задачи пользователя.',
  input_schema: { type: 'object', properties: {} },
  async execute(_input, ctx) {
    const tasks = tasksRepo.listOpen(ctx.userId);
    if (tasks.length === 0) return 'Открытых задач нет.';
    return tasks
      .map((tk, i) => {
        const due = tk.due_at ? ` — до ${formatDate(tk.due_at, ctx.timezone)}` : '';
        return `${i + 1}. ${tk.title}${due}`;
      })
      .join('\n');
  },
};

export const completeTaskTool: Tool = {
  name: 'complete_task',
  description:
    'Отметить задачу выполненной по её тексту. Вызывай на «сделал X», «готово с X», «выполнил X».',
  input_schema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Текст или часть текста выполненной задачи.' },
    },
    required: ['title'],
  },
  async execute(input, ctx) {
    const done = tasksRepo.complete(ctx.userId, input.title);
    return done ? `Отметил выполненной: «${done}». 👍` : 'Не нашёл такой открытой задачи.';
  },
};
