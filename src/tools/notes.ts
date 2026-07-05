import type { Tool } from './types';
import { notesRepo } from '../db/repositories';

export const saveNoteTool: Tool = {
  name: 'save_note',
  description:
    'Сохранить простую заметку без привязки ко времени и без конкретного человека. Вызывай, когда ' +
    'пользователь просит что-то запомнить «на будущее» («запомни, что переговоры перенесли на пятницу»). ' +
    'Если заметка про конкретного человека — используй save_contact_note.',
  input_schema: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'Текст заметки.' },
    },
    required: ['text'],
  },
  async execute(input, ctx) {
    notesRepo.add(ctx.userId, input.text);
    return `Заметка сохранена: «${input.text}».`;
  },
};

export const listNotesTool: Tool = {
  name: 'list_notes',
  description:
    'Показать сохранённые общие заметки пользователя. Вызывай на вопросы «какие у меня заметки?», ' +
    '«что я просил запомнить?».',
  input_schema: {
    type: 'object',
    properties: {},
  },
  async execute(_input, ctx) {
    const notes = notesRepo.list(ctx.userId);
    if (notes.length === 0) return 'Сохранённых заметок нет.';
    return notes.map((n, i) => `${i + 1}. ${n}`).join('\n');
  },
};
