import type { Tool } from './types';
import { contactsRepo, notesRepo } from '../db/repositories';

export const saveRecapTool: Tool = {
  name: 'save_recap',
  description:
    'Сохранить итог встречи или пересланной переписки (recap). Вызывай, когда пользователь пересылает кусок ' +
    'переписки или описывает встречу и хочет зафиксировать итог. Сначала сам суммируй: о чём договорились и ' +
    'какие следующие шаги, затем вызови этот инструмент. Если известен человек, к которому относится встреча, ' +
    'укажи contact_name — recap привяжется к его карточке; иначе он сохранится как общая заметка.',
  input_schema: {
    type: 'object',
    properties: {
      contact_name: {
        type: 'string',
        description: 'Имя человека, к которому относится встреча/переписка (если применимо).',
      },
      summary: {
        type: 'string',
        description: 'Краткое содержание: кто участвовал и о чём договорились.',
      },
      next_steps: {
        type: 'array',
        items: { type: 'string' },
        description: 'Список следующих шагов (может быть пустым).',
      },
    },
    required: ['summary'],
  },
  async execute(input, ctx) {
    const steps: string[] = Array.isArray(input.next_steps) ? input.next_steps : [];
    const stepsBlock =
      steps.length > 0 ? `\nСледующие шаги:\n${steps.map((s) => `• ${s}`).join('\n')}` : '';
    const recapText = `Итог: ${input.summary}${stepsBlock}`;

    if (input.contact_name && String(input.contact_name).trim() !== '') {
      contactsRepo.addNote(ctx.userId, input.contact_name, recapText);
      return `Recap сохранён и привязан к контакту «${input.contact_name}».`;
    }
    notesRepo.add(ctx.userId, recapText);
    return 'Recap сохранён как общая заметка.';
  },
};
