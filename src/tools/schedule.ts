import type { Tool } from './types';
import { scheduledRepo, contactsRepo } from '../db/repositories';

function fmt(iso: string, tz: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat('ru-RU', { timeZone: tz, dateStyle: 'medium', timeStyle: 'short' }).format(d);
}

export const scheduleMessageTool: Tool = {
  name: 'schedule_message',
  description:
    'Запланировать отправку сообщения или письма на будущее время (не сейчас). Вызывай на «отправь Ержану в 21:00», ' +
    '«напиши Айгуль завтра в 9 утра», «отправь это письмо вечером». Канал: telegram (получатель — пользователь Velora ' +
    'по @username) или email (по адресу). Получателя можно указать именем сохранённого контакта — почта/ник подтянутся сами. ' +
    'Всегда сначала покажи пользователю текст и время и получи подтверждение, а потом вызывай инструмент.',
  input_schema: {
    type: 'object',
    properties: {
      send_at: { type: 'string', description: 'Когда отправить, ISO 8601 со смещением +05:00, напр. 2026-07-07T21:00:00+05:00.' },
      channel: { type: 'string', enum: ['telegram', 'email'], description: 'Канал доставки.' },
      contact_name: { type: 'string', description: 'Имя сохранённого контакта — почта/@username подтянутся автоматически. Необязательно.' },
      to: { type: 'string', description: 'Явный получатель: @username (telegram) или email. Необязательно, если задан contact_name.' },
      subject: { type: 'string', description: 'Тема письма (только для email).' },
      body: { type: 'string', description: 'Текст сообщения/письма.' },
    },
    required: ['send_at', 'channel', 'body'],
  },
  async execute(input, ctx) {
    const when = new Date(input.send_at);
    if (Number.isNaN(when.getTime())) return 'Не удалось разобрать время отправки. Уточни дату и время.';
    if (when.getTime() < Date.now() - 60_000) return 'Это время уже в прошлом. Уточни, когда именно отправить.';

    const channel = input.channel === 'email' ? 'email' : 'telegram';

    // Определяем получателя: явный `to` или подтягиваем из сохранённого контакта.
    let target = input.to?.trim() || '';
    if (!target && input.contact_name) {
      const c = contactsRepo.getDetails(ctx.userId, input.contact_name);
      if (c) target = channel === 'email' ? c.email || '' : c.telegram_username ? `@${c.telegram_username}` : '';
    }

    if (!target) {
      const what = channel === 'email' ? 'email' : '@username';
      return `Не знаю, куда отправить (${what}). Попроси пользователя указать получателя или сохранить контакт с этими данными.`;
    }
    if (channel === 'email' && !target.includes('@')) return 'Для email нужен корректный адрес получателя.';

    // Если получатель задан явно вместе с именем — запоминаем контакт, чтобы
    // в следующий раз можно было писать просто по имени, не диктуя адрес.
    if (input.to && input.contact_name) {
      if (channel === 'email') contactsRepo.setDetails(ctx.userId, input.contact_name, target);
      else contactsRepo.setDetails(ctx.userId, input.contact_name, undefined, target);
    }

    scheduledRepo.create({
      userId: ctx.userId,
      chatId: ctx.chatId,
      channel,
      target,
      subject: input.subject?.trim() || null,
      body: input.body,
      sendAt: when.getTime(),
    });

    return `Запланировал отправку для ${target} на ${fmt(input.send_at, ctx.timezone)}. Отправлю сама в это время. ✅`;
  },
};
