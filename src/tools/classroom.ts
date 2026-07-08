import type { Tool } from './types';
import { composio } from '../integrations/composio/client';
import { logger } from '../logger';

const API = 'https://classroom.googleapis.com/v1';

/** Достаёт человекочитаемую причину ошибки из ответа/исключения Google API. */
function errDetail(x: any): string {
  const d = x?.response?.data ?? x?.data ?? x?.body ?? x;
  const g = d?.error;
  if (g?.message) return `${g.status || g.code || ''} ${g.message}`.trim();
  if (typeof d === 'string') return d.slice(0, 300);
  try {
    return JSON.stringify(d).slice(0, 300);
  } catch {
    return x?.message ?? 'неизвестная ошибка';
  }
}

/** Сырой вызов Google Classroom API через подключение пользователя в Composio. */
async function proxy(userId: number, endpoint: string, method: string, body?: unknown): Promise<any> {
  const res: any = await (composio() as any).tools.proxyExecute({
    toolkitSlug: 'google_classroom',
    userId: String(userId),
    data: { endpoint, method, ...(body !== undefined ? { body } : {}) },
  });
  const data = res?.data ?? res?.body ?? res;
  // Composio может не бросать исключение на 4xx — ловим ошибку в теле сами.
  const status = res?.status ?? res?.statusCode ?? data?.status;
  if ((typeof status === 'number' && status >= 400) || data?.error) {
    throw new Error(errDetail(res));
  }
  return data;
}

const norm = (s: string) => s.trim().toLowerCase();

/** Находит курс по названию (или части) среди курсов студента. */
async function findCourse(userId: number, name: string): Promise<{ id: string; name: string } | null> {
  const data = await proxy(userId, `${API}/courses?studentId=me&pageSize=100`, 'GET');
  const courses: any[] = data?.courses ?? [];
  const q = norm(name);
  const hit =
    courses.find((c) => norm(c.name ?? '') === q) || courses.find((c) => norm(c.name ?? '').includes(q));
  return hit ? { id: hit.id, name: hit.name } : null;
}

/** Находит задание по названию (или части) в курсе. */
async function findWork(userId: number, courseId: string, title: string): Promise<{ id: string; title: string } | null> {
  const data = await proxy(userId, `${API}/courses/${courseId}/courseWork?pageSize=100`, 'GET');
  const work: any[] = data?.courseWork ?? [];
  const q = norm(title);
  const hit = work.find((w) => norm(w.title ?? '') === q) || work.find((w) => norm(w.title ?? '').includes(q));
  return hit ? { id: hit.id, title: hit.title } : null;
}

export const submitClassroomWorkTool: Tool = {
  name: 'submit_classroom_work',
  description:
    'Сдать (turn in) задание в Google Classroom от имени студента, при необходимости прикрепив ссылку на работу ' +
    '(например ссылку на Google Doc или файл). Вызывай на «сдай работу по …», «прикрепи и отправь …», «сдай задание …». ' +
    'Укажи название курса и задания — инструмент сам найдёт их id. Чтобы приложить написанную работу — сначала создай ' +
    'Google Doc через инструменты Docs, возьми ссылку и передай её в link. ОБЯЗАТЕЛЬНО сначала покажи пользователю, что ' +
    'именно сдаёшь (курс, задание, ссылку), и получи подтверждение.',
  input_schema: {
    type: 'object',
    properties: {
      course_name: { type: 'string', description: 'Название курса (можно часть), напр. «Extended Essay».' },
      assignment_name: { type: 'string', description: 'Название задания (можно часть).' },
      link: { type: 'string', description: 'Ссылка на работу для прикрепления (Google Doc/файл/URL). Необязательно.' },
    },
    required: ['course_name', 'assignment_name'],
  },
  async execute(input, ctx) {
    try {
      const course = await findCourse(ctx.userId, input.course_name);
      if (!course) return `Не нашла курс «${input.course_name}». Проверь название или подключён ли Google Classroom.`;

      const work = await findWork(ctx.userId, course.id, input.assignment_name);
      if (!work) return `В курсе «${course.name}» не нашла задание «${input.assignment_name}».`;

      // Находим студенческую работу (submission) по этому заданию.
      const subs = await proxy(
        ctx.userId,
        `${API}/courses/${course.id}/courseWork/${work.id}/studentSubmissions?userId=me`,
        'GET',
      );
      const submission = subs?.studentSubmissions?.[0];
      if (!submission?.id) return `Не нашла твою работу по заданию «${work.title}» (возможно, оно не для сдачи).`;

      const base = `${API}/courses/${course.id}/courseWork/${work.id}/studentSubmissions/${submission.id}`;

      // Прикрепляем ссылку, если дана.
      if (input.link) {
        await proxy(ctx.userId, `${base}:modifyAttachments`, 'POST', {
          addAttachments: [{ link: { url: input.link } }],
        });
      }

      // Сдаём работу.
      await proxy(ctx.userId, `${base}:turnIn`, 'POST', {});

      const attached = input.link ? ` (прикрепила ссылку)` : '';
      return `Готово! Сдала задание «${work.title}» по курсу «${course.name}»${attached}. ✅`;
    } catch (err) {
      const msg = err instanceof Error ? err.message : errDetail(err);
      logger.error({ err, userId: ctx.userId }, 'Ошибка сдачи работы в Classroom');
      return `Не удалось сдать работу. Причина от Google: ${msg}`;
    }
  },
};
