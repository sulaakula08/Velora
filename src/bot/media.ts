import type TelegramBot from 'node-telegram-bot-api';
import type { Part } from '@google/genai';

/** Скачивает файл Telegram по file_id и возвращает его как inlineData-часть для Gemini. */
async function fileToPart(bot: TelegramBot, fileId: string, mimeType: string): Promise<Part> {
  const link = await bot.getFileLink(fileId);
  const res = await fetch(link);
  const buffer = Buffer.from(await res.arrayBuffer());
  return { inlineData: { mimeType, data: buffer.toString('base64') } };
}

export interface CollectedMedia {
  /** Мультимодальные части для передачи модели (пусто, если вложений нет). */
  parts: Part[];
  /** Короткая метка для истории диалога (например, «[фото]»). */
  label: string;
}

/**
 * Извлекает вложение из сообщения Telegram (фото, голосовое, аудио, документ)
 * и готовит его для отправки в Gemini. Gemini мультимодален и понимает
 * изображения, аудио и PDF/текстовые документы «из коробки».
 */
export async function collectMedia(bot: TelegramBot, msg: TelegramBot.Message): Promise<CollectedMedia> {
  if (msg.photo && msg.photo.length > 0) {
    // Берём самый крупный размер (последний в массиве).
    const largest = msg.photo[msg.photo.length - 1];
    return { parts: [await fileToPart(bot, largest.file_id, 'image/jpeg')], label: '[фото]' };
  }

  if (msg.voice) {
    return {
      parts: [await fileToPart(bot, msg.voice.file_id, msg.voice.mime_type || 'audio/ogg')],
      label: '[голосовое]',
    };
  }

  if (msg.audio) {
    return {
      parts: [await fileToPart(bot, msg.audio.file_id, msg.audio.mime_type || 'audio/mpeg')],
      label: '[аудио]',
    };
  }

  if (msg.document) {
    const doc = msg.document;
    const label = doc.file_name ? `[документ: ${doc.file_name}]` : '[документ]';
    return {
      parts: [await fileToPart(bot, doc.file_id, doc.mime_type || 'application/octet-stream')],
      label,
    };
  }

  return { parts: [], label: '' };
}
