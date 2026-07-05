import type { Tool } from './types';
import { usersRepo } from '../db/repositories';
import { t } from '../i18n/i18n';

/**
 * Отправка сообщения другому человеку в Telegram ЧЕРЕЗ Velora.
 * Работает только если получатель тоже пользуется этим ботом (мы знаем его chat_id).
 * Иначе инструмент честно сообщает об этом, и модель отдаёт пользователю готовый текст
 * для ручной пересылки. Это первый кирпич мультиплеера (агент↔агент), как у folk.
 */
export const sendToPersonTool: Tool = {
  name: 'send_to_person',
  description:
    'Отправить сообщение другому человеку в Telegram через Velora. Работает ТОЛЬКО если получатель тоже ' +
    'пользуется этим ботом; получателя указывай в recipient как его @username. Если получателя нет в Velora — ' +
    'инструмент вернёт это, и тогда ты просто дай пользователю готовый текст, чтобы он отправил сам, и предложи ' +
    'пригласить собеседника в бота. Всегда показывай пользователю текст, который отправляешь.',
  input_schema: {
    type: 'object',
    properties: {
      recipient: {
        type: 'string',
        description: 'Получатель — его Telegram @username (например, @aigul).',
      },
      message: { type: 'string', description: 'Текст сообщения для отправки.' },
    },
    required: ['recipient', 'message'],
  },
  async execute(input, ctx) {
    const username = String(input.recipient).trim().replace(/^@/, '');
    if (!username) {
      return 'Нужен @username получателя. Попроси пользователя уточнить, кому отправить.';
    }

    const target = usersRepo.findByUsername(username);
    if (!target || !target.chat_id) {
      return (
        `Получатель @${username} не найден среди пользователей Velora, поэтому отправить напрямую нельзя. ` +
        `Дай пользователю готовый текст сообщения, чтобы он переслал его сам, и предложи пригласить @${username} ` +
        `в бота (тогда в следующий раз можно будет отправлять через Velora).`
      );
    }

    // Не отправляем сообщение самому себе.
    if (target.user_id === ctx.userId) {
      return 'Это твой собственный аккаунт — отправлять самому себе не нужно.';
    }

    const sender = ctx.senderUsername ? `@${ctx.senderUsername}` : ctx.senderName;
    const text = t('relayed_message', target.language, { sender, message: input.message });

    try {
      await ctx.sendTo(target.chat_id, text);
    } catch {
      return 'Не удалось доставить сообщение получателю. Предложи пользователю отправить текст самому.';
    }

    return `Отправил сообщение @${username} в Telegram через Velora. ✅`;
  },
};
