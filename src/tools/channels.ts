import type { Tool } from './types';
import { channelsRepo } from '../db/repositories';

/** Похоже ли на прямой идентификатор канала (@username или числовой id). */
function isDirectRef(s: string): boolean {
  return s.startsWith('@') || /^-?\d+$/.test(s);
}

export const postToChannelTool: Tool = {
  name: 'post_to_channel',
  description:
    'Опубликовать пост в Telegram-канал или группу пользователя. Работает ТОЛЬКО если бот добавлен в этот канал ' +
    'администратором с правом публикации. Вызывай на «запости в канал…», «сделай пост в мой канал», «объяви в группе». ' +
    'Канал укажи как @username, числовой id или по сохранённому названию. Всегда сначала покажи текст поста и получи ' +
    'подтверждение. Бот НЕ может писать незнакомым людям в личку — только в свои каналы/группы или пользователям Velora.',
  input_schema: {
    type: 'object',
    properties: {
      channel: { type: 'string', description: 'Канал: @username, id или сохранённое название.' },
      text: { type: 'string', description: 'Текст поста.' },
      name: { type: 'string', description: 'Понятное название канала, чтобы запомнить его на будущее (необязательно).' },
    },
    required: ['channel', 'text'],
  },
  async execute(input, ctx) {
    let ref = String(input.channel).trim();

    // Если это не @username и не id — ищем среди сохранённых каналов по названию.
    if (!isDirectRef(ref)) {
      const found = channelsRepo.find(ctx.userId, ref);
      if (!found) {
        return (
          `Не нашла канал «${ref}». Укажи @username канала (например @mychannel) и убедись, что я добавлена туда ` +
          `администратором с правом публикации.`
        );
      }
      ref = found.ref;
    }

    try {
      await ctx.sendTo(ref, input.text);
      channelsRepo.add(ctx.userId, ref, input.name);
      return `Опубликовала пост в ${ref}. ✅`;
    } catch {
      return (
        `Не удалось опубликовать в ${ref}. Проверь, что бот добавлен в этот канал/группу АДМИНИСТРАТОРОМ ` +
        `с правом публикации сообщений, и попробуй снова.`
      );
    }
  },
};
