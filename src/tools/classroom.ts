import type { Tool } from './types';
import { composio } from '../integrations/composio/client';
import { logger } from '../logger';

const API = 'https://classroom.googleapis.com/v1';

/** Достаёт причину ошибки Google из ответа/исключения. */
function errDetail(x: any): string {
  const d = x?.response?.data ?? x?.data ?? x?.body ?? x;
  const g = d?.error;
  if (g?.message) return `${g.status || g.code || ''} ${g.message}`.trim();
  if (typeof d === 'string') return d.slice(0, 300);
  if (x?.message) return String(x.message).slice(0, 300);
  try {
    return JSON.stringify(d).slice(0, 300);
  } catch {
    return 'неизвестная ошибка';
  }
}

/** Сырой вызов Google Classroom API через конкретное подключение (connectedAccountId). */
async function proxy(accountId: string, endpoint: string, method: string, body?: unknown): Promise<any> {
  const res: any = await (composio() as any).tools.proxyExecute({
    toolkitSlug: 'google_classroom',
    connectedAccountId: accountId,
    endpoint,
    method,
    ...(body !== undefined ? { body } : {}),
  });
  const data = res?.data ?? res?.body ?? res;
  const status = res?.status ?? res?.statusCode ?? data?.status;
  if ((typeof status === 'number' && status >= 400) || data?.error) throw new Error(errDetail(res));
  return data;
}

/** Активные подключения Google Classroom пользователя (может быть несколько аккаунтов). */
async function classroomAccounts(userId: number): Promise<string[]> {
  const list: any = await (composio() as any).connectedAccounts.list({ userIds: [String(userId)] });
  const items: any[] = list?.items ?? (Array.isArray(list) ? list : []);
  return items
    .filter((a) => (a.toolkit?.slug ?? a.toolkitSlug) === 'google_classroom' && a.status === 'ACTIVE')
    .map((a) => a.id);
}

const norm = (s: string) => s.trim().toLowerCase();

export const submitClassroomWorkTool: Tool = {
  name: 'submit_classroom_work',
  description:
    'Сдать (turn in) задание в Google Classroom от имени студента, при необходимости прикрепив ссылку на работу ' +
    '(например ссылку на Google Doc). Вызывай на «сдай работу по …», «прикрепи и отправь …». Укажи название курса и ' +
    'задания — инструмент сам найдёт нужный подключённый аккаунт и id. Чтобы приложить написанную работу — сперва ' +
    'создай Google Doc через инструменты Docs, возьми ссылку и передай в link. ОБЯЗАТЕЛЬНО сначала покажи пользователю ' +
    'курс, задание и ссылку и получи подтверждение — сдача необратима.',
  input_schema: {
    type: 'object',
    properties: {
      course_name: { type: 'string', description: 'Название курса (можно часть), напр. «Extended Essay».' },
      assignment_name: { type: 'string', description: 'Название задания (можно часть).' },
      link: { type: 'string', description: 'Ссылка на работу (Google Doc/URL) для прикрепления. Необязательно.' },
    },
    required: ['course_name', 'assignment_name'],
  },
  async execute(input, ctx) {
    try {
      const accounts = await classroomAccounts(ctx.userId);
      if (accounts.length === 0) return 'Google Classroom не подключён. Подключи его через /connect.';

      // Ищем курс среди всех подключённых аккаунтов (личный + школьный и т.п.).
      const q = norm(input.course_name);
      let accountId = '';
      let course: { id: string; name: string } | null = null;
      for (const a of accounts) {
        const data = await proxy(a, `${API}/courses?courseStates=ACTIVE&pageSize=200`, 'GET');
        const courses: any[] = data?.courses ?? [];
        const hit =
          courses.find((c) => norm(c.name ?? '') === q) || courses.find((c) => norm(c.name ?? '').includes(q));
        if (hit) {
          accountId = a;
          course = { id: hit.id, name: hit.name };
          break;
        }
      }
      if (!course) return `Не нашла курс «${input.course_name}» ни в одном из подключённых аккаунтов Classroom.`;

      // Ищем задание.
      const cwData = await proxy(accountId, `${API}/courses/${course.id}/courseWork?pageSize=200`, 'GET');
      const work = (cwData?.courseWork ?? []).find((w: any) => norm(w.title ?? '').includes(norm(input.assignment_name)));
      if (!work) return `В курсе «${course.name}» не нашла задание «${input.assignment_name}».`;

      // Находим свою работу (submission).
      const subData = await proxy(
        accountId,
        `${API}/courses/${course.id}/courseWork/${work.id}/studentSubmissions?userId=me`,
        'GET',
      );
      const submission = subData?.studentSubmissions?.[0];
      if (!submission?.id) return `Не нашла твою работу по «${work.title}» (возможно, это не задание для сдачи).`;

      const base = `${API}/courses/${course.id}/courseWork/${work.id}/studentSubmissions/${submission.id}`;

      if (input.link) {
        await proxy(accountId, `${base}:modifyAttachments`, 'POST', { addAttachments: [{ link: { url: input.link } }] });
      }
      await proxy(accountId, `${base}:turnIn`, 'POST', {});

      const attached = input.link ? ' (прикрепила ссылку)' : '';
      return `Готово! Сдала задание «${work.title}» по курсу «${course.name}»${attached}. ✅`;
    } catch (err) {
      logger.error({ err, userId: ctx.userId }, 'Ошибка сдачи работы в Classroom');
      return `Не удалось сдать работу. Причина от Google: ${errDetail(err)}`;
    }
  },
};
