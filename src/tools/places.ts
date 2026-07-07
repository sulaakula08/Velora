import type { Tool } from './types';
import { ai } from '../ai/client';
import { config } from '../config';
import { logger } from '../logger';

/**
 * Поиск локальных заведений (кафе, аптеки, магазины, услуги) с уклоном в местные
 * справочники (2ГИС, Яндекс.Карты). Реализован поверх встроенного grounding Gemini
 * (Google Search) — не требует отдельных API-ключей.
 *
 * TODO: позже заменить внутренности на полноценную интеграцию 2GIS API
 * (точные координаты, часы работы, маршруты) — интерфейс инструмента сохранить.
 */
export const findPlacesTool: Tool = {
  name: 'find_places',
  description:
    'Найти конкретные заведения и места поблизости: кафе, рестораны, аптеки, банкоматы, магазины, СТО, ' +
    'салоны и т.п. Вызывай на запросы вроде «кофейня рядом», «где ближайшая аптека», «хорошие суши в Алматы», ' +
    '«банкомат Kaspi поблизости». Возвращает список с адресами и часами работы. Для общих фактов используй web_search.',
  input_schema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Что ищем: тип заведения или название, на языке пользователя. Напр. «кофейня», «аптека 24 часа».',
      },
      area: {
        type: 'string',
        description: 'Город/район/ориентир, если известны из диалога (напр. «Алматы, Медеуский район»). Необязательно.',
      },
    },
    required: ['query'],
  },
  async execute(input, ctx) {
    const area = input.area?.trim();
    const where = area ? ` в: ${area}` : ` (город определи из контекста, по умолчанию Казахстан)`;

    const prompt =
      `Найди реальные заведения по запросу: "${input.query}"${where}. ` +
      `Предпочитай данные из местных справочников — прежде всего 2ГИС (2gis.kz) и Яндекс.Карт. ` +
      `Верни 3–5 подходящих мест. Для каждого укажи, если есть: название, адрес, часы работы, телефон, рейтинг. ` +
      `Оформи списком, кратко и по делу, на языке пользователя. Если данных мало — честно скажи об этом. ` +
      `Часовой пояс пользователя: ${ctx.timezone}.`;

    try {
      const response = await ai.models.generateContent({
        model: config.model,
        contents: prompt,
        config: { tools: [{ googleSearch: {} }] },
      });

      const text = response.text?.trim() || 'По этому запросу мест не нашлось.';

      const chunks = response.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [];
      const sources = chunks
        .map((c) => c.web?.title || c.web?.uri)
        .filter((s): s is string => Boolean(s))
        .slice(0, 3);

      return sources.length > 0 ? `${text}\n\nИсточники: ${sources.join('; ')}` : text;
    } catch (err) {
      logger.error({ err, query: input.query }, 'Ошибка поиска мест');
      return 'Не удалось найти места. Попробуй уточнить город или район.';
    }
  },
};
