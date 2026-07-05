import type { Tool } from './types';
import { profileRepo } from '../db/repositories';

export const rememberAboutMeTool: Tool = {
  name: 'remember_about_me',
  description:
    'Запомнить факт о САМОМ пользователе (не о других людях): имя, город, работа, семья, ' +
    'предпочтения, цели, привычки. Вызывай, когда пользователь рассказывает о себе — эти факты ' +
    'учитываются во всех будущих ответах. Один вызов — один факт.',
  input_schema: {
    type: 'object',
    properties: {
      fact: { type: 'string', description: 'Факт о пользователе, короткой фразой.' },
    },
    required: ['fact'],
  },
  async execute(input, ctx) {
    profileRepo.add(ctx.userId, input.fact);
    return `Запомнил о тебе: «${input.fact}».`;
  },
};

export const getAboutMeTool: Tool = {
  name: 'get_about_me',
  description:
    'Показать, что известно о самом пользователе. Вызывай на вопросы «что ты обо мне знаешь?».',
  input_schema: { type: 'object', properties: {} },
  async execute(_input, ctx) {
    const facts = profileRepo.list(ctx.userId);
    if (facts.length === 0) return 'О пользователе пока ничего не сохранено.';
    return facts.map((f, i) => `${i + 1}. ${f}`).join('\n');
  },
};

export const forgetAboutMeTool: Tool = {
  name: 'forget_about_me',
  description:
    'Забыть факты о пользователе по теме/подстроке. Вызывай на просьбы «забудь, что я…», ' +
    '«удали информацию про…».',
  input_schema: {
    type: 'object',
    properties: {
      topic: { type: 'string', description: 'Тема или слово, факты по которым нужно удалить.' },
    },
    required: ['topic'],
  },
  async execute(input, ctx) {
    const removed = profileRepo.forget(ctx.userId, input.topic);
    return removed > 0 ? `Забыл (${removed}).` : 'Ничего подходящего для удаления не нашёл.';
  },
};
