import type { Content, Part } from '@google/genai';
import { ai } from './client';
import { buildSystemPrompt } from './systemPrompt';
import { config } from '../config';
import { logger } from '../logger';
import { functionDeclarations, toolMap } from '../tools/registry';
import type { ToolContext } from '../tools/types';
import { profileRepo, toolUsageRepo, type StoredMessage } from '../db/repositories';
import { isComposioConfigured } from '../integrations/composio/client';
import { getComposioTools, executeComposio } from '../integrations/composio/tools';

const MAX_TOOL_ITERATIONS = 6;

/**
 * Запускает диалоговый цикл с Gemini: подтягивает историю, вызывает модель,
 * при наличии function calls исполняет инструменты и продолжает, пока модель
 * не вернёт текстовый ответ. Возвращает финальный текст для пользователя.
 */
export async function runAgent(
  history: StoredMessage[],
  userText: string,
  ctx: ToolContext,
  mediaParts: Part[] = [],
): Promise<string> {
  const currentParts: Part[] = [...mediaParts, { text: userText }];
  const contents: Content[] = [
    ...history.map(
      (m): Content => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      }),
    ),
    { role: 'user', parts: currentParts },
  ];

  // Инструменты Composio для подключённых пользователем приложений (если настроено).
  let composioSlugs = new Set<string>();
  const declarations = [...functionDeclarations()];
  if (isComposioConfigured()) {
    try {
      const bundle = await getComposioTools(ctx.userId);
      declarations.push(...bundle.declarations);
      composioSlugs = bundle.slugs;
    } catch (err) {
      logger.error({ err }, 'Не удалось подтянуть инструменты Composio');
    }
  }

  const generationConfig = {
    systemInstruction: buildSystemPrompt(profileRepo.list(ctx.userId), {
      // senderName может быть подстановкой-заглушкой «Пользователь» — тогда имя не передаём.
      firstName: ctx.senderName === 'Пользователь' ? undefined : ctx.senderName,
      username: ctx.senderUsername,
    }),
    tools: [{ functionDeclarations: declarations }],
  };

  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    const response = await ai.models.generateContent({
      model: config.model,
      contents,
      config: generationConfig,
    });

    const calls = response.functionCalls ?? [];

    if (calls.length > 0) {
      // Сохраняем ход модели (с function call), затем отвечаем результатами инструментов.
      const modelContent = response.candidates?.[0]?.content;
      if (modelContent) contents.push(modelContent);

      const parts = [];
      for (const call of calls) {
        const name = call.name ?? '';
        const args = (call.args ?? {}) as Record<string, any>;
        const tool = toolMap.get(name);
        if (name) toolUsageRepo.log(ctx.userId, name);
        let result: string;
        try {
          if (tool) {
            result = await tool.execute(args, ctx);
          } else if (composioSlugs.has(name)) {
            result = await executeComposio(ctx.userId, name, args);
          } else {
            result = `Неизвестный инструмент: ${name}`;
          }
        } catch (err) {
          logger.error({ err, tool: name }, 'Ошибка выполнения инструмента');
          result = `Ошибка при выполнении инструмента ${name}.`;
        }
        parts.push({ functionResponse: { name, response: { result } } });
      }

      contents.push({ role: 'user', parts });
      continue;
    }

    const text = response.text?.trim();
    return text || '…';
  }

  logger.warn('Достигнут лимит итераций function calling');
  return 'Не удалось завершить запрос за отведённое число шагов. Попробуй переформулировать.';
}
