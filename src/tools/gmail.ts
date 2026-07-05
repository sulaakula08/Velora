import type { Tool } from './types';
import { getUserClient } from '../integrations/google/oauth';
import { listRecent, sendEmail } from '../integrations/google/gmail';

const NOT_CONNECTED =
  'Google не подключён. Скажи пользователю выполнить команду /connect_google, чтобы дать доступ к почте.';

export const listEmailsTool: Tool = {
  name: 'list_recent_emails',
  description:
    'Показать сводку последних писем во входящих Gmail (кто, тема, о чём). Вызывай на «что нового на почте», ' +
    '«проверь почту». Требует подключённого Google.',
  input_schema: {
    type: 'object',
    properties: {
      count: { type: 'integer', description: 'Сколько писем показать (по умолчанию 5).' },
    },
  },
  async execute(input, ctx) {
    const client = getUserClient(ctx.userId);
    if (!client) return NOT_CONNECTED;

    const max = Math.min(Math.max(Number(input.count) || 5, 1), 10);
    try {
      const emails = await listRecent(client, max);
      if (emails.length === 0) return 'Новых писем нет.';
      return emails
        .map((e, i) => `${i + 1}. От: ${e.from}\n   Тема: ${e.subject}\n   ${e.snippet}`)
        .join('\n\n');
    } catch (err) {
      return `Не удалось прочитать почту: ${err instanceof Error ? err.message : 'ошибка Google'}.`;
    }
  },
};

export const sendEmailTool: Tool = {
  name: 'send_email',
  description:
    'Отправить письмо от имени пользователя через Gmail. ОБЯЗАТЕЛЬНО сначала покажи пользователю получателя, ' +
    'тему и текст и получи подтверждение, и только потом вызывай этот инструмент. Требует подключённого Google.',
  input_schema: {
    type: 'object',
    properties: {
      to: { type: 'string', description: 'Email получателя.' },
      subject: { type: 'string', description: 'Тема письма.' },
      body: { type: 'string', description: 'Текст письма.' },
    },
    required: ['to', 'subject', 'body'],
  },
  async execute(input, ctx) {
    const client = getUserClient(ctx.userId);
    if (!client) return NOT_CONNECTED;

    try {
      await sendEmail(client, input.to, input.subject, input.body);
      return `Письмо отправлено на ${input.to}. ✅`;
    } catch (err) {
      return `Не удалось отправить письмо: ${err instanceof Error ? err.message : 'ошибка Google'}.`;
    }
  },
};
