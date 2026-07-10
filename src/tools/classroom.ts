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

export const listClassroomCoursesTool: Tool = {
  name: 'list_classroom_courses',
  description:
    'Показать курсы пользователя в Google Classroom по ВСЕМ подключённым Google-аккаунтам (личный, школьный и т.п.). ' +
    'Используй ЭТОТ инструмент для списка курсов вместо других — он видит все аккаунты, а не один. Вызывай на «мои курсы», ' +
    '«какие у меня курсы», а также перед сдачей работы, чтобы точно найти нужный курс.',
  input_schema: { type: 'object', properties: {} },
  async execute(_input, ctx) {
    try {
      const accounts = await classroomAccounts(ctx.userId);
      if (accounts.length === 0) return 'Google Classroom не подключён. Подключи через /connect.';
      const lines: string[] = [];
      for (const a of accounts) {
        const prof = await proxy(a, `${API}/userProfiles/me`, 'GET').catch(() => null);
        const who = prof?.name?.fullName || prof?.emailAddress || 'аккаунт';
        const data = await proxy(a, `${API}/courses?courseStates=ACTIVE&pageSize=200`, 'GET');
        const names = (data?.courses ?? []).map((c: any) => `• ${String(c.name ?? '').replace(/^"|"$/g, '')}`);
        lines.push(`Аккаунт «${who}»:\n${names.length ? names.join('\n') : '— нет активных курсов'}`);
      }
      return lines.join('\n\n');
    } catch (err) {
      logger.error({ err, userId: ctx.userId }, 'Ошибка списка курсов Classroom');
      return `Не удалось получить курсы: ${errDetail(err)}`;
    }
  },
};

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
    let assignmentLink = ''; // прямая ссылка на задание — для ручной сдачи, если авто заблокировано
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
      assignmentLink = work.alternateLink || '';

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

      // ПРОВЕРЯЕМ реальный результат — не полагаемся на «нет ошибки».
      const check = await proxy(accountId, base, 'GET');
      if (check?.state !== 'TURNED_IN') {
        return `Сдача не подтвердилась: состояние работы «${check?.state ?? 'неизвестно'}». Ничего не сдано — попробуй ещё раз.`;
      }
      const attCount = check?.assignmentSubmission?.attachments?.length ?? 0;
      const attNote = input.link
        ? attCount > 0
          ? ' (документ прикреплён)'
          : ' ⚠️ но вложение не прикрепилось — проверь в Classroom'
        : '';
      return `Готово, работа реально сдана: «${work.title}» — курс «${course.name}»${attNote}. ✅`;
    } catch (err) {
      const detail = errDetail(err);
      logger.error({ err, userId: ctx.userId }, 'Ошибка сдачи работы в Classroom');
      // Жёсткое ограничение Google: сдавать/прикреплять может только приложение,
      // создавшее задание. Учительские задания сторонний бот сдать не может.
      if (/permission_denied|projectpermissiondenied|not permitted/i.test(detail)) {
        const steps = [
          'Сдать автоматически нельзя — это ограничение Google Classroom (не школы): прикреплять и сдавать может только приложение, создавшее задание, а его создал учитель. Обойти это не может ни один бот.',
          '',
          'Но я всё подготовила — сдать вручную это 20 секунд:',
        ];
        if (assignmentLink) steps.push(`1. Открой задание: ${assignmentLink}`);
        else steps.push('1. Открой это задание в Google Classroom');
        if (input.link) steps.push(`2. Прикрепи документ: ${input.link}`);
        steps.push(`${input.link ? '3' : '2'}. Нажми «Сдать» / «Turn in».`);
        return steps.join('\n');
      }
      return `Не удалось сдать работу. Причина от Google: ${detail}`;
    }
  },
};
