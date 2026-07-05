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
    'Сохранить заметку/контекст о конкретном человеке (мини-CRM). Вызывай, когда пользователь сообщает ' +
    'факт о ком-то: имя, роль, где познакомились, день рождения, договорённости и т.п. Примеры: ' +
    '«сохрани: Ержан — директор завода, познакомились на конференции», «у Айгуль день рождения 5 августа». ' +
    'Один вызов — одна заметка о человеке.',
  input_schema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Имя человека, к которому относится заметка.' },
      note: { type: 'string', description: 'Что запомнить об этом человеке.' },
    },
    required: ['name', 'note'],
  },
  async execute(input, ctx) {
    contactsRepo.addNote(ctx.userId, input.name, input.note);
    return `Записал про ${input.name}: «${input.note}».`;
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
    const notes = contactsRepo.getNotes(ctx.userId, input.name);
    if (notes.length === 0) {
      return `О человеке по имени «${input.name}» пока ничего не сохранено.`;
    }
    const lines = notes.map((n) => `- [${formatDate(n.created_at, ctx.timezone)}] ${n.note}`);
    return `Известно о «${input.name}»:\n${lines.join('\n')}`;
  },
};
