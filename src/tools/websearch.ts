import type { Tool } from './types';
import { ai } from '../ai/client';
import { config } from '../config';
import { logger } from '../logger';

/**
 * Веб-поиск через встроенный в Gemini grounding (Google Search).
 * Реализован как изолированный запрос: основной диалог использует function calling,
 * а здесь мы отдельно вызываем модель только с googleSearch — так нет конфликта
 * между встроенным инструментом поиска и нашими function declarations.
 */
export const webSearchTool: Tool = {
  name: 'web_search',
  description:
    'Найти актуальную информацию в интернете. Вызывай, когда ответ зависит от свежих или внешних данных, ' +
    'которых нет в диалоге: погода, курсы валют, новости, факты, часы работы, места рядом, цены, спортивные ' +
    'результаты и т.п. Формулируй query на языке пользователя.',
  input_schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Поисковый запрос на языке пользователя.' },
    },
    required: ['query'],
  },
  async execute(input) {
    try {
      const response = await ai.models.generateContent({
        model: config.model,
        contents: input.query,
        config: { tools: [{ googleSearch: {} }] },
      });

      const text = response.text?.trim() || 'По запросу ничего не нашлось.';

      // Добавим источники из grounding-метаданных, чтобы модель могла на них ссылаться.
      const chunks = response.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [];
      const sources = chunks
        .map((c) => c.web?.title || c.web?.uri)
        .filter((s): s is string => Boolean(s))
        .slice(0, 3);

      return sources.length > 0 ? `${text}\n\nИсточники: ${sources.join('; ')}` : text;
    } catch (err) {
      logger.error({ err, query: input.query }, 'Ошибка веб-поиска');
      return 'Не удалось выполнить веб-поиск. Ответь пользователю на основе имеющихся знаний.';
    }
  },
};
