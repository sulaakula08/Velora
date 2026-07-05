import { composio } from './client';
import { composioRepo } from '../../db/repositories';
import { toGeminiSchema } from '../../tools/schema';
import { logger } from '../../logger';

// Кэш сырых схем инструментов по тулкиту (схемы одинаковы для всех пользователей).
const schemaCache = new Map<string, any[]>();
// Ограничение числа инструментов на тулкит для тулкитов без явного списка ниже.
const MAX_TOOLS_PER_TOOLKIT = 12;

// Явный список ключевых инструментов по тулкиту. У Gmail/Календаря их десятки —
// грузим только нужные, иначе важное (напр. отправка письма) обрежется лимитом,
// а контекст модели раздувается. Для остальных тулкитов берём первые N.
const PREFERRED_TOOLS: Record<string, string[]> = {
  gmail: [
    'GMAIL_SEND_EMAIL',
    'GMAIL_FETCH_EMAILS',
    'GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID',
    'GMAIL_CREATE_EMAIL_DRAFT',
    'GMAIL_SEND_DRAFT',
    'GMAIL_REPLY_TO_THREAD',
    'GMAIL_LIST_THREADS',
    'GMAIL_GET_CONTACTS',
    'GMAIL_GET_PROFILE',
    'GMAIL_MOVE_TO_TRASH',
  ],
  googlecalendar: [
    'GOOGLECALENDAR_CREATE_EVENT',
    'GOOGLECALENDAR_EVENTS_LIST',
    'GOOGLECALENDAR_FIND_EVENT',
    'GOOGLECALENDAR_UPDATE_EVENT',
    'GOOGLECALENDAR_DELETE_EVENT',
    'GOOGLECALENDAR_QUICK_ADD',
    'GOOGLECALENDAR_FIND_FREE_SLOTS',
    'GOOGLECALENDAR_GET_CURRENT_DATE_TIME',
  ],
};

async function toolsForToolkit(toolkit: string): Promise<any[]> {
  const cached = schemaCache.get(toolkit);
  if (cached) return cached;
  try {
    const preferred = PREFERRED_TOOLS[toolkit];
    // Для известных тулкитов запрашиваем конкретные слуги, иначе — весь тулкит.
    const filter = preferred ? { tools: preferred } : { toolkits: [toolkit] };
    const result: any = await (composio() as any).tools.get('default', filter);
    const arr: any[] = Array.isArray(result) ? result : (result?.items ?? []);
    const limited = preferred ? arr : arr.slice(0, MAX_TOOLS_PER_TOOLKIT);
    schemaCache.set(toolkit, limited);
    return limited;
  } catch (err) {
    logger.error({ err, toolkit }, 'Не удалось получить инструменты Composio');
    return [];
  }
}

export interface ComposioBundle {
  /** Function declarations для Gemini. */
  declarations: any[];
  /** Множество slug'ов инструментов Composio (для маршрутизации выполнения). */
  slugs: Set<string>;
}

/** Собирает инструменты Composio для подключённых пользователем тулкитов. */
export async function getComposioTools(userId: number): Promise<ComposioBundle> {
  const toolkits = composioRepo.listToolkits(userId);
  const declarations: any[] = [];
  const slugs = new Set<string>();

  for (const toolkit of toolkits) {
    const tools = await toolsForToolkit(toolkit);
    for (const tool of tools) {
      // SDK отдаёт инструменты в OpenAI-формате: { type:'function', function:{ name, description, parameters } }.
      // На всякий случай поддерживаем и «плоский» вид (slug/inputParameters).
      const fn = tool.function ?? tool;
      const slug: string | undefined = fn.name ?? tool.slug;
      if (!slug) continue;
      const params = fn.parameters ?? tool.inputParameters ?? { type: 'object', properties: {} };
      declarations.push({
        name: slug,
        description: fn.description ?? tool.description ?? '',
        parameters: toGeminiSchema(params),
      });
      slugs.add(slug);
    }
  }

  return { declarations, slugs };
}

/** Выполняет инструмент Composio от имени пользователя, возвращает текст результата. */
export async function executeComposio(
  userId: number,
  slug: string,
  args: Record<string, any>,
): Promise<string> {
  try {
    const result: any = await (composio() as any).tools.execute(slug, {
      userId: String(userId),
      arguments: args,
      // Тулкиты используются в версии latest; без этого флага SDK требует
      // явную версию и кидает ComposioToolVersionRequiredError.
      dangerouslySkipVersionCheck: true,
    });
    const data = result?.data ?? result;
    const text = typeof data === 'string' ? data : JSON.stringify(data);
    return text.slice(0, 4000);
  } catch (err) {
    logger.error({ err, slug }, 'Ошибка выполнения инструмента Composio');
    return `Не удалось выполнить действие (${slug}): ${err instanceof Error ? err.message : 'ошибка Composio'}.`;
  }
}
