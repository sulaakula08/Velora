import type { Tool } from './types';
import { contactsRepo } from '../db/repositories';

function formatDate(epoch: number, timezone: string): string {
  return new Intl.DateTimeFormat('ru-RU', { timeZone: timezone, dateStyle: 'medium' }).format(
    new Date(epoch),
  );
}

export const saveContactNoteTool: Tool = {
  name: 'save_contact_note',
  description:
    'Сохранить контакт и/или заметку о человеке (мини-CRM). Вызывай, когда пользователь сообщает факт о ком-то ' +
    'ИЛИ его данные для связи: имя, роль, день рождения, а также email и/или Telegram @username. Примеры: ' +
    '«сохрани: Ержан — директор, почта erzhan@mail.kz», «Айгуль — @aigul», «у Данияра др 5 августа». ' +
    'Сохранённые email/username потом используются, чтобы писать человеку по имени, не диктуя адрес заново.',
  input_schema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Имя человека.' },
      note: { type: 'string', description: 'Что запомнить о человеке (необязательно, если сохраняем только контакт).' },
      email: { type: 'string', description: 'Email человека, если известен (необязательно).' },
      telegram_username: { type: 'string', description: 'Telegram @username человека, если известен (необязательно).' },
    },
    required: ['name'],
  },
  async execute(input, ctx) {
    if (input.email || input.telegram_username) {
      contactsRepo.setDetails(ctx.userId, input.name, input.email, input.telegram_username);
    }
    if (input.note) contactsRepo.addNote(ctx.userId, input.name, input.note);

    const parts: string[] = [];
    if (input.note) parts.push(`заметку «${input.note}»`);
    if (input.email) parts.push(`почту ${input.email}`);
    if (input.telegram_username) parts.push(`ник @${input.telegram_username.replace(/^@/, '')}`);
    const what = parts.length ? parts.join(', ') : 'контакт';
    return `Сохранил про ${input.name}: ${what}.`;
  },
};

export const getContactInfoTool: Tool = {
  name: 'get_contact_info',
  description:
    'Достать всё, что известно о человеке, чтобы затем обобщить для пользователя. Вызывай на вопросы ' +
    'вроде «что я знаю про Ержана?», «расскажи про Айгуль». Верни пользователю связную выжимку, ' +
    'а не сырой список.',
  input_schema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Имя человека, о котором спрашивают.' },
    },
    required: ['name'],
  },
  async execute(input, ctx) {
    const details = contactsRepo.getDetails(ctx.userId, input.name);
    const notes = contactsRepo.getNotes(ctx.userId, input.name);
    if (!details && notes.length === 0) {
      return `О человеке по имени «${input.name}» пока ничего не сохранено.`;
    }
    const lines: string[] = [];
    if (details?.email) lines.push(`- Email: ${details.email}`);
    if (details?.telegram_username) lines.push(`- Telegram: @${details.telegram_username}`);
    notes.forEach((n) => lines.push(`- [${formatDate(n.created_at, ctx.timezone)}] ${n.note}`));
    return `Известно о «${input.name}»:\n${lines.join('\n')}`;
  },
};
