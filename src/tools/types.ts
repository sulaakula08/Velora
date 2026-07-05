import type { Lang } from '../i18n/i18n';

/**
 * Контекст выполнения инструмента. Передаётся в execute каждого тула.
 * Сюда позже легко добавить, например, OAuth-токены Google, не меняя сигнатуру.
 */
export interface ToolContext {
  userId: number;
  chatId: number;
  lang: Lang;
  timezone: string;
  /** Имя отправителя (для подписи при пересылке сообщений другим пользователям). */
  senderName: string;
  /** @username отправителя, если есть. */
  senderUsername?: string;
  /** Отправить сообщение в произвольный чат Telegram (инструмент не знает про Telegram-библиотеку). */
  sendTo(chatId: number, text: string): Promise<void>;
}

/**
 * Единый интерфейс инструмента. Любой новый тул (Google Calendar, Gmail и т.д.)
 * реализует ровно эту форму и регистрируется в tools/registry.ts — ядро менять не нужно.
 */
export interface Tool {
  /** Имя, которое видит модель (snake_case). */
  name: string;
  /** Описание для модели: когда и зачем вызывать инструмент. */
  description: string;
  /** JSON Schema входных параметров. */
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
  /** Выполняет инструмент и возвращает текстовый результат для модели. */
  execute(input: Record<string, any>, ctx: ToolContext): Promise<string>;
}
