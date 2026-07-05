import type { Tool } from './types';
import { toGeminiSchema } from './schema';
import { createReminderTool, listRemindersTool } from './reminders';
import { saveNoteTool, listNotesTool } from './notes';
import { saveContactNoteTool, getContactInfoTool } from './contacts';
import { saveRecapTool } from './recap';
import { webSearchTool } from './websearch';
import { rememberAboutMeTool, getAboutMeTool, forgetAboutMeTool } from './profile';
import { addTaskTool, listTasksTool, completeTaskTool } from './tasks';
import { sendToPersonTool } from './messaging';
// Родные Google-тулзы (calendar.ts/gmail.ts) отключены: работа с Gmail и
// Календарём идёт через Composio (см. integrations/composio). Оставлены в коде
// на случай возврата к собственному Google OAuth.

/**
 * Единый реестр всех инструментов, доступных модели.
 * Чтобы добавить новую интеграцию (например, Google Calendar), достаточно
 * реализовать интерфейс Tool и добавить сюда — ядро (agent.ts) менять не нужно.
 */
export const tools: Tool[] = [
  createReminderTool,
  listRemindersTool,
  saveNoteTool,
  listNotesTool,
  saveContactNoteTool,
  getContactInfoTool,
  saveRecapTool,
  webSearchTool,
  rememberAboutMeTool,
  getAboutMeTool,
  forgetAboutMeTool,
  addTaskTool,
  listTasksTool,
  completeTaskTool,
  sendToPersonTool,
];

/** Быстрый доступ к инструменту по имени (для обработки function calls). */
export const toolMap: Map<string, Tool> = new Map(tools.map((tool) => [tool.name, tool]));

/** Описания инструментов в формате Gemini function declarations. */
export function functionDeclarations(): any[] {
  return tools.map((tool) => {
    const parameters = toGeminiSchema(tool.input_schema);
    const hasProps =
      parameters.properties && Object.keys(parameters.properties).length > 0;
    return {
      name: tool.name,
      description: tool.description,
      // Gemini не любит parameters с пустым properties — опускаем для инструментов без аргументов.
      ...(hasProps ? { parameters } : {}),
    };
  });
}
