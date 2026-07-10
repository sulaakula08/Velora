import { db } from './db';
import type { Lang } from '../i18n/i18n';

export interface UserRow {
  user_id: number;
  chat_id: number;
  language: Lang;
  language_locked: number;
  created_at: number;
  briefing_enabled: number;
  briefing_hour: number;
  last_briefing_date: string | null;
  username: string | null;
  first_name: string | null;
  voice_mode: VoiceMode;
  referred_by: number | null;
  ref_rewarded: number;
  trial_granted: number;
}

export type VoiceMode = 'off' | 'reply' | 'always';

export interface BriefingCandidate {
  user_id: number;
  chat_id: number;
  language: Lang;
  briefing_hour: number;
  last_briefing_date: string | null;
}

export interface TaskRow {
  id: number;
  title: string;
  due_at: number | null;
  status: string;
}

export interface StoredMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface DueReminder {
  id: number;
  chat_id: number;
  text: string;
  language: Lang;
}

// ---------- users ----------

const stmtEnsureUser = db.prepare(
  `INSERT INTO users (user_id, chat_id, username, first_name, created_at)
   VALUES (@userId, @chatId, @username, @firstName, @now)
   ON CONFLICT(user_id) DO UPDATE SET
     chat_id = @chatId, username = @username, first_name = @firstName`,
);
const stmtGetUser = db.prepare(`SELECT * FROM users WHERE user_id = ?`);
const stmtGetUserByUsername = db.prepare(
  `SELECT * FROM users WHERE lower(username) = lower(?)`,
);
const stmtSetLang = db.prepare(
  `UPDATE users SET language = @lang, language_locked = @locked WHERE user_id = @userId`,
);
const stmtUpdateDetected = db.prepare(
  `UPDATE users SET language = @lang WHERE user_id = @userId AND language_locked = 0`,
);
const stmtSetBriefing = db.prepare(
  `UPDATE users SET briefing_enabled = @enabled, briefing_hour = @hour WHERE user_id = @userId`,
);
const stmtBriefingCandidates = db.prepare(
  `SELECT user_id, chat_id, language, briefing_hour, last_briefing_date
   FROM users WHERE briefing_enabled = 1`,
);
const stmtMarkBriefing = db.prepare(
  `UPDATE users SET last_briefing_date = @date WHERE user_id = @userId`,
);
const stmtSetVoiceMode = db.prepare(
  `UPDATE users SET voice_mode = @mode WHERE user_id = @userId`,
);
const stmtSetReferredBy = db.prepare(
  `UPDATE users SET referred_by = @refId WHERE user_id = @userId AND referred_by IS NULL`,
);
const stmtMarkRefRewarded = db.prepare(`UPDATE users SET ref_rewarded = 1 WHERE user_id = ?`);
const stmtMarkTrialGranted = db.prepare(`UPDATE users SET trial_granted = 1 WHERE user_id = ?`);
const stmtCountReferrals = db.prepare(
  `SELECT COUNT(*) AS n FROM users WHERE referred_by = ?`,
);

export const usersRepo = {
  ensure(userId: number, chatId: number, username?: string, firstName?: string): UserRow {
    stmtEnsureUser.run({
      userId,
      chatId,
      username: username ?? null,
      firstName: firstName ?? null,
      now: Date.now(),
    });
    return stmtGetUser.get(userId) as UserRow;
  },
  get(userId: number): UserRow | undefined {
    return stmtGetUser.get(userId) as UserRow | undefined;
  },
  /** Находит пользователя Velora по его Telegram @username (без учёта регистра). */
  findByUsername(username: string): UserRow | undefined {
    return stmtGetUserByUsername.get(username.trim().replace(/^@/, '')) as UserRow | undefined;
  },
  setLanguage(userId: number, lang: Lang, locked: boolean): void {
    stmtSetLang.run({ userId, lang, locked: locked ? 1 : 0 });
  },
  /** Обновляет язык интерфейса по автоопределению, только если пользователь не зафиксировал его вручную. */
  updateDetected(userId: number, lang: Lang): void {
    stmtUpdateDetected.run({ userId, lang });
  },
  setBriefing(userId: number, enabled: boolean, hour: number): void {
    stmtSetBriefing.run({ userId, enabled: enabled ? 1 : 0, hour });
  },
  briefingCandidates(): BriefingCandidate[] {
    return stmtBriefingCandidates.all() as BriefingCandidate[];
  },
  markBriefingSent(userId: number, date: string): void {
    stmtMarkBriefing.run({ userId, date });
  },
  setVoiceMode(userId: number, mode: VoiceMode): void {
    stmtSetVoiceMode.run({ userId, mode });
  },
  /** Привязывает пригласившего (только если ещё не задан). */
  setReferredBy(userId: number, refId: number): void {
    stmtSetReferredBy.run({ userId, refId });
  },
  markRefRewarded(userId: number): void {
    stmtMarkRefRewarded.run(userId);
  },
  markTrialGranted(userId: number): void {
    stmtMarkTrialGranted.run(userId);
  },
  countReferrals(userId: number): number {
    return (stmtCountReferrals.get(userId) as { n: number }).n;
  },
};

// ---------- messages (история диалога) ----------

const stmtAddMessage = db.prepare(
  `INSERT INTO messages (user_id, role, content, created_at) VALUES (?, ?, ?, ?)`,
);
const stmtRecentMessages = db.prepare(
  `SELECT role, content FROM messages WHERE user_id = ? ORDER BY id DESC LIMIT ?`,
);
const stmtCountUserSince = db.prepare(
  `SELECT COUNT(*) AS n FROM messages WHERE user_id = ? AND role = 'user' AND created_at >= ?`,
);

export const messagesRepo = {
  add(userId: number, role: 'user' | 'assistant', content: string): void {
    stmtAddMessage.run(userId, role, content, Date.now());
  },
  /** Возвращает последние N сообщений в хронологическом порядке (от старых к новым). */
  recent(userId: number, limit: number): StoredMessage[] {
    const rows = stmtRecentMessages.all(userId, limit) as StoredMessage[];
    return rows.reverse();
  },
  /** Сколько сообщений пользователь отправил начиная с момента since (эпоха, мс). */
  countUserSince(userId: number, since: number): number {
    const row = stmtCountUserSince.get(userId, since) as { n: number };
    return row.n;
  },
};

// ---------- reminders ----------

const stmtCreateReminder = db.prepare(
  `INSERT INTO reminders (user_id, chat_id, text, remind_at, created_at)
   VALUES (@userId, @chatId, @text, @remindAt, @now)`,
);
const stmtDueReminders = db.prepare(
  `SELECT r.id AS id, r.chat_id AS chat_id, r.text AS text, u.language AS language
   FROM reminders r JOIN users u ON u.user_id = r.user_id
   WHERE r.sent = 0 AND r.remind_at <= ?`,
);
const stmtMarkSent = db.prepare(`UPDATE reminders SET sent = 1 WHERE id = ?`);
const stmtListReminders = db.prepare(
  `SELECT text, remind_at FROM reminders
   WHERE user_id = ? AND sent = 0 ORDER BY remind_at ASC LIMIT ?`,
);
const stmtRemindersBy = db.prepare(
  `SELECT text, remind_at FROM reminders
   WHERE user_id = ? AND sent = 0 AND remind_at <= ? ORDER BY remind_at ASC`,
);

export const remindersRepo = {
  create(userId: number, chatId: number, text: string, remindAt: number): void {
    stmtCreateReminder.run({ userId, chatId, text, remindAt, now: Date.now() });
  },
  getDue(now: number): DueReminder[] {
    return stmtDueReminders.all(now) as DueReminder[];
  },
  markSent(id: number): void {
    stmtMarkSent.run(id);
  },
  listPending(userId: number, limit = 20): { text: string; remind_at: number }[] {
    return stmtListReminders.all(userId, limit) as { text: string; remind_at: number }[];
  },
  /** Ненаступившие напоминания со сроком не позже ts (для утреннего брифинга). */
  pendingBy(userId: number, ts: number): { text: string; remind_at: number }[] {
    return stmtRemindersBy.all(userId, ts) as { text: string; remind_at: number }[];
  },
};

// ---------- scheduled_messages (отложенная отправка сообщений/писем) ----------

export interface ScheduledMessage {
  id: number;
  user_id: number;
  chat_id: number;
  channel: 'telegram' | 'email' | 'channel';
  target: string;
  subject: string | null;
  body: string;
  send_at: number;
}

const stmtCreateScheduled = db.prepare(
  `INSERT INTO scheduled_messages (user_id, chat_id, channel, target, subject, body, send_at, created_at)
   VALUES (@userId, @chatId, @channel, @target, @subject, @body, @sendAt, @now)`,
);
const stmtDueScheduled = db.prepare(
  `SELECT id, user_id, chat_id, channel, target, subject, body, send_at
   FROM scheduled_messages WHERE sent = 0 AND send_at <= ? ORDER BY send_at ASC`,
);
const stmtMarkScheduledSent = db.prepare(`UPDATE scheduled_messages SET sent = 1 WHERE id = ?`);
const stmtListScheduled = db.prepare(
  `SELECT id, user_id, chat_id, channel, target, subject, body, send_at
   FROM scheduled_messages WHERE user_id = ? AND sent = 0 ORDER BY send_at ASC LIMIT ?`,
);

export const scheduledRepo = {
  create(msg: {
    userId: number;
    chatId: number;
    channel: 'telegram' | 'email' | 'channel';
    target: string;
    subject: string | null;
    body: string;
    sendAt: number;
  }): void {
    stmtCreateScheduled.run({ ...msg, now: Date.now() });
  },
  getDue(now: number): ScheduledMessage[] {
    return stmtDueScheduled.all(now) as ScheduledMessage[];
  },
  markSent(id: number): void {
    stmtMarkScheduledSent.run(id);
  },
  listPending(userId: number, limit = 20): ScheduledMessage[] {
    return stmtListScheduled.all(userId, limit) as ScheduledMessage[];
  },
};

// ---------- channels (каналы/группы пользователя для постинга) ----------

export interface ChannelRow {
  ref: string;
  title: string | null;
}

const stmtAddChannel = db.prepare(
  `INSERT INTO channels (user_id, ref, title, created_at) VALUES (@userId, @ref, @title, @now)
   ON CONFLICT(user_id, ref) DO UPDATE SET title = COALESCE(@title, title)`,
);
const stmtListChannels = db.prepare(
  `SELECT ref, title FROM channels WHERE user_id = ? ORDER BY id DESC`,
);

export const channelsRepo = {
  add(userId: number, ref: string, title?: string): void {
    stmtAddChannel.run({ userId, ref: ref.trim(), title: title?.trim() || null, now: Date.now() });
  },
  list(userId: number): ChannelRow[] {
    return stmtListChannels.all(userId) as ChannelRow[];
  },
  /** Ищет канал по ref или по части названия (без учёта регистра). */
  find(userId: number, query: string): ChannelRow | undefined {
    const q = query.trim().toLowerCase().replace(/^@/, '');
    return this.list(userId).find(
      (c) => c.ref.toLowerCase().replace(/^@/, '') === q || (c.title ?? '').toLowerCase().includes(q),
    );
  },
};

// ---------- notes (общие заметки без времени) ----------

const stmtAddNote = db.prepare(
  `INSERT INTO notes (user_id, text, created_at) VALUES (?, ?, ?)`,
);
const stmtListNotes = db.prepare(
  `SELECT text FROM notes WHERE user_id = ? ORDER BY id DESC LIMIT ?`,
);

export const notesRepo = {
  add(userId: number, text: string): void {
    stmtAddNote.run(userId, text, Date.now());
  },
  list(userId: number, limit = 50): string[] {
    const rows = stmtListNotes.all(userId, limit) as { text: string }[];
    return rows.map((r) => r.text);
  },
};

// ---------- contacts (мини-CRM) ----------

const stmtInsertContact = db.prepare(
  `INSERT OR IGNORE INTO contacts (user_id, name, created_at) VALUES (?, ?, ?)`,
);
const stmtGetContact = db.prepare(
  `SELECT id FROM contacts WHERE user_id = ? AND unicode_lower(name) = unicode_lower(?)`,
);
const stmtAddContactNote = db.prepare(
  `INSERT INTO contact_notes (contact_id, note, created_at) VALUES (?, ?, ?)`,
);
const stmtGetContactNotes = db.prepare(
  `SELECT note, created_at FROM contact_notes WHERE contact_id = ? ORDER BY id ASC`,
);
const stmtGetContactRow = db.prepare(
  `SELECT id, name, email, telegram_username FROM contacts
   WHERE user_id = ? AND unicode_lower(name) = unicode_lower(?)`,
);
const stmtUpdateContactDetails = db.prepare(
  `UPDATE contacts SET
     email = COALESCE(@email, email),
     telegram_username = COALESCE(@username, telegram_username)
   WHERE id = @id`,
);

export interface ContactDetails {
  id: number;
  name: string;
  email: string | null;
  telegram_username: string | null;
}

export const contactsRepo = {
  /** Находит контакт по имени (без учёта регистра) или создаёт новый; возвращает id. */
  ensure(userId: number, name: string): number {
    const trimmed = name.trim();
    stmtInsertContact.run(userId, trimmed, Date.now());
    const row = stmtGetContact.get(userId, trimmed) as { id: number };
    return row.id;
  },
  addNote(userId: number, name: string, note: string): void {
    const contactId = this.ensure(userId, name);
    stmtAddContactNote.run(contactId, note, Date.now());
  },
  /** Возвращает все заметки о контакте (пустой массив, если контакта нет). */
  getNotes(userId: number, name: string): { note: string; created_at: number }[] {
    const row = stmtGetContact.get(userId, name.trim()) as { id: number } | undefined;
    if (!row) return [];
    return stmtGetContactNotes.all(row.id) as { note: string; created_at: number }[];
  },
  /** Сохраняет/обновляет почту и/или Telegram-ник контакта (создаёт при отсутствии). */
  setDetails(userId: number, name: string, email?: string, username?: string): void {
    const id = this.ensure(userId, name);
    stmtUpdateContactDetails.run({
      id,
      email: email?.trim() || null,
      username: username?.trim().replace(/^@/, '') || null,
    });
  },
  /** Возвращает контакт с почтой и ником по имени (или undefined). */
  getDetails(userId: number, name: string): ContactDetails | undefined {
    return stmtGetContactRow.get(userId, name.trim()) as ContactDetails | undefined;
  },
};

// ---------- profile (долговременная память о пользователе) ----------

const stmtAddFact = db.prepare(
  `INSERT INTO profile_facts (user_id, fact, created_at) VALUES (?, ?, ?)`,
);
const stmtListFacts = db.prepare(
  `SELECT fact FROM profile_facts WHERE user_id = ? ORDER BY id ASC`,
);
const stmtForgetFacts = db.prepare(
  `DELETE FROM profile_facts WHERE user_id = ? AND fact LIKE ?`,
);

export const profileRepo = {
  add(userId: number, fact: string): void {
    stmtAddFact.run(userId, fact.trim(), Date.now());
  },
  list(userId: number): string[] {
    const rows = stmtListFacts.all(userId) as { fact: string }[];
    return rows.map((r) => r.fact);
  },
  /** Удаляет факты, содержащие подстроку topic. Возвращает число удалённых. */
  forget(userId: number, topic: string): number {
    const res = stmtForgetFacts.run(userId, `%${topic.trim()}%`);
    return res.changes;
  },
};

// ---------- tasks (дела с трекингом и авто-follow-up) ----------

const stmtAddTask = db.prepare(
  `INSERT INTO tasks (user_id, chat_id, title, due_at, follow_up_at, created_at)
   VALUES (@userId, @chatId, @title, @dueAt, @followUpAt, @now)`,
);
const stmtOpenTasks = db.prepare(
  `SELECT id, title, due_at, status FROM tasks
   WHERE user_id = ? AND status = 'open' ORDER BY (due_at IS NULL), due_at ASC, id ASC`,
);
const stmtTasksDueBy = db.prepare(
  `SELECT id, title, due_at, status FROM tasks
   WHERE user_id = ? AND status = 'open' AND due_at IS NOT NULL AND due_at <= ?
   ORDER BY due_at ASC`,
);
const stmtFindOpenTask = db.prepare(
  `SELECT id, title FROM tasks
   WHERE user_id = ? AND status = 'open' AND unicode_lower(title) LIKE unicode_lower(?)
   ORDER BY id ASC LIMIT 1`,
);
const stmtCompleteTask = db.prepare(`UPDATE tasks SET status = 'done' WHERE id = ?`);
const stmtDueFollowUps = db.prepare(
  `SELECT t.id AS id, t.chat_id AS chat_id, t.title AS title, u.language AS language
   FROM tasks t JOIN users u ON u.user_id = t.user_id
   WHERE t.status = 'open' AND t.followed_up = 0
     AND t.follow_up_at IS NOT NULL AND t.follow_up_at <= ?`,
);
const stmtMarkFollowedUp = db.prepare(`UPDATE tasks SET followed_up = 1 WHERE id = ?`);

export interface DueFollowUp {
  id: number;
  chat_id: number;
  title: string;
  language: Lang;
}

// ---------- google_tokens (OAuth-токены Google на пользователя) ----------

const stmtSaveGoogleTokens = db.prepare(
  `INSERT INTO google_tokens (user_id, tokens, created_at)
   VALUES (@userId, @tokens, @now)
   ON CONFLICT(user_id) DO UPDATE SET tokens = @tokens`,
);
const stmtGetGoogleTokens = db.prepare(`SELECT tokens FROM google_tokens WHERE user_id = ?`);
const stmtDeleteGoogleTokens = db.prepare(`DELETE FROM google_tokens WHERE user_id = ?`);

export const googleTokensRepo = {
  save(userId: number, tokens: string): void {
    stmtSaveGoogleTokens.run({ userId, tokens, now: Date.now() });
  },
  get(userId: number): string | undefined {
    const row = stmtGetGoogleTokens.get(userId) as { tokens: string } | undefined;
    return row?.tokens;
  },
  delete(userId: number): void {
    stmtDeleteGoogleTokens.run(userId);
  },
  has(userId: number): boolean {
    return stmtGetGoogleTokens.get(userId) !== undefined;
  },
};

// ---------- composio_connections (какие тулкиты подключил пользователь) ----------

const stmtAddComposio = db.prepare(
  `INSERT OR IGNORE INTO composio_connections (user_id, toolkit, created_at) VALUES (?, ?, ?)`,
);
const stmtListComposio = db.prepare(
  `SELECT toolkit FROM composio_connections WHERE user_id = ? ORDER BY toolkit`,
);
const stmtRemoveComposio = db.prepare(
  `DELETE FROM composio_connections WHERE user_id = ? AND toolkit = ?`,
);

export const composioRepo = {
  add(userId: number, toolkit: string): void {
    stmtAddComposio.run(userId, toolkit, Date.now());
  },
  listToolkits(userId: number): string[] {
    const rows = stmtListComposio.all(userId) as { toolkit: string }[];
    return rows.map((r) => r.toolkit);
  },
  remove(userId: number, toolkit: string): void {
    stmtRemoveComposio.run(userId, toolkit);
  },
  count(userId: number): number {
    return composioRepo.listToolkits(userId).length;
  },
};

// ---------- stats (админ-аналитика) ----------

const stmtCountUsers = db.prepare(`SELECT COUNT(*) AS n FROM users`);
const stmtCountUsersSince = db.prepare(`SELECT COUNT(*) AS n FROM users WHERE created_at >= ?`);
const stmtCountActivePro = db.prepare(
  `SELECT COUNT(*) AS n FROM subscriptions
   WHERE status = 'active' AND (current_period_end IS NULL OR current_period_end > ?)`,
);
const stmtCountAllUserMessages = db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE role = 'user'`);
const stmtCountMessagesSince = db.prepare(
  `SELECT COUNT(*) AS n FROM messages WHERE role = 'user' AND created_at >= ?`,
);
const stmtCountReferred = db.prepare(`SELECT COUNT(*) AS n FROM users WHERE referred_by IS NOT NULL`);
const stmtCountPendingScheduled = db.prepare(`SELECT COUNT(*) AS n FROM scheduled_messages WHERE sent = 0`);
const stmtCountActiveUsersSince = db.prepare(
  `SELECT COUNT(DISTINCT user_id) AS n FROM messages WHERE role = 'user' AND created_at >= ?`,
);
const stmtActiveDetailed = db.prepare(
  `SELECT u.user_id, u.username, u.first_name, COUNT(m.id) AS msgs
   FROM users u JOIN messages m ON m.user_id = u.user_id
   WHERE m.role = 'user' AND m.created_at >= @since
   GROUP BY u.user_id ORDER BY msgs DESC LIMIT @limit`,
);
const stmtTopToolUser = db.prepare(
  `SELECT tool, COUNT(*) AS n FROM tool_usage WHERE user_id = ? AND created_at >= ?
   GROUP BY tool ORDER BY n DESC LIMIT 1`,
);

const n = (row: unknown) => (row as { n: number }).n;

// Возвраты: активны за последние 7 дней И были активны в предыдущие 7 дней.
const stmtReturningUsers = db.prepare(
  `SELECT COUNT(DISTINCT user_id) AS n FROM messages
   WHERE role = 'user' AND created_at >= @weekAgo
     AND user_id IN (
       SELECT user_id FROM messages
       WHERE role = 'user' AND created_at >= @twoWeeksAgo AND created_at < @weekAgo
     )`,
);
const stmtSubsByProvider = db.prepare(
  `SELECT provider, COUNT(*) AS n FROM subscriptions
   WHERE status = 'active' AND (current_period_end IS NULL OR current_period_end > ?)
   GROUP BY provider`,
);
const stmtIntegrationAdoption = db.prepare(
  `SELECT toolkit, COUNT(DISTINCT user_id) AS n FROM composio_connections GROUP BY toolkit ORDER BY n DESC`,
);
const stmtTopTools = db.prepare(
  `SELECT tool, COUNT(*) AS n FROM tool_usage WHERE created_at >= ? GROUP BY tool ORDER BY n DESC LIMIT ?`,
);
const stmtTableCount = (table: string) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`);
const stmtReminders = stmtTableCount('reminders');
const stmtTasksCount = stmtTableCount('tasks');
const stmtNotesCount = stmtTableCount('notes');
const stmtContactsCount = stmtTableCount('contacts');

export const statsRepo = {
  totalUsers: () => n(stmtCountUsers.get()),
  newUsersSince: (since: number) => n(stmtCountUsersSince.get(since)),
  activePro: (now = Date.now()) => n(stmtCountActivePro.get(now)),
  totalPrompts: () => n(stmtCountAllUserMessages.get()),
  promptsSince: (since: number) => n(stmtCountMessagesSince.get(since)),
  activeUsersSince: (since: number) => n(stmtCountActiveUsersSince.get(since)),
  referredUsers: () => n(stmtCountReferred.get()),
  pendingScheduled: () => n(stmtCountPendingScheduled.get()),
  returningUsers: (now = Date.now()) =>
    n(stmtReturningUsers.get({ weekAgo: now - 7 * 864e5, twoWeeksAgo: now - 14 * 864e5 })),
  subsByProvider: (now = Date.now()) =>
    stmtSubsByProvider.all(now) as { provider: string | null; n: number }[],
  integrationAdoption: () => stmtIntegrationAdoption.all() as { toolkit: string; n: number }[],
  topTools: (since: number, limit = 15) =>
    stmtTopTools.all(since, limit) as { tool: string; n: number }[],
  featureCounts: () => ({
    reminders: n(stmtReminders.get()),
    tasks: n(stmtTasksCount.get()),
    notes: n(stmtNotesCount.get()),
    contacts: n(stmtContactsCount.get()),
  }),
  activeUsersDetailed: (since: number, limit = 30) =>
    stmtActiveDetailed.all({ since, limit }) as {
      user_id: number;
      username: string | null;
      first_name: string | null;
      msgs: number;
    }[],
  topToolForUser: (userId: number, since: number) =>
    stmtTopToolUser.get(userId, since) as { tool: string; n: number } | undefined,
};

// ---------- feedback (мнения пользователей) ----------

const stmtAddFeedback = db.prepare(
  `INSERT INTO feedback (user_id, username, text, anonymous, created_at) VALUES (?, ?, ?, ?, ?)`,
);
const stmtListFeedback = db.prepare(
  `SELECT user_id, username, text, anonymous, created_at FROM feedback ORDER BY id DESC LIMIT ?`,
);

export const feedbackRepo = {
  /** Анонимно — не сохраняем ни id, ни username (настоящая анонимность). */
  add(userId: number, username: string | undefined, text: string, anonymous: boolean): void {
    stmtAddFeedback.run(
      anonymous ? null : userId,
      anonymous ? null : username ?? null,
      text,
      anonymous ? 1 : 0,
      Date.now(),
    );
  },
  listRecent(limit = 20): {
    user_id: number | null;
    username: string | null;
    text: string;
    anonymous: number;
    created_at: number;
  }[] {
    return stmtListFeedback.all(limit) as any[];
  },
};

// ---------- tool_usage (какие инструменты вызывают) ----------

const stmtLogTool = db.prepare(
  `INSERT INTO tool_usage (user_id, tool, created_at) VALUES (?, ?, ?)`,
);

export const toolUsageRepo = {
  log(userId: number, tool: string): void {
    try {
      stmtLogTool.run(userId, tool, Date.now());
    } catch {
      /* аналитика не должна ломать основной поток */
    }
  },
};

// ---------- обслуживание (сброс статистики) ----------

const stmtDeleteAllMessages = db.prepare(`DELETE FROM messages`);
const stmtDeleteAllToolUsage = db.prepare(`DELETE FROM tool_usage`);

export const maintenanceRepo = {
  /**
   * Обнуляет статистику использования: удаляет историю сообщений (промпты, DAU/WAU)
   * и логи вызовов инструментов. Пользователи и подписки НЕ трогаются.
   */
  resetUsageStats(): { messages: number; tools: number } {
    const reset = db.transaction(() => {
      const messages = stmtDeleteAllMessages.run().changes;
      const tools = stmtDeleteAllToolUsage.run().changes;
      return { messages, tools };
    });
    return reset();
  },
};

// ---------- subscriptions (подписка Pro) ----------

export interface SubscriptionRow {
  user_id: number;
  status: string; // 'active' | 'cancelled' | 'expired'
  current_period_end: number | null;
  provider: string | null;
  provider_ref: string | null;
  updated_at: number;
}

const stmtGetSub = db.prepare(`SELECT * FROM subscriptions WHERE user_id = ?`);
const stmtUpsertSub = db.prepare(
  `INSERT INTO subscriptions (user_id, status, current_period_end, provider, provider_ref, updated_at)
   VALUES (@userId, @status, @periodEnd, @provider, @ref, @now)
   ON CONFLICT(user_id) DO UPDATE SET
     status = @status, current_period_end = @periodEnd,
     provider = @provider, provider_ref = @ref, updated_at = @now`,
);
const stmtSetSubStatus = db.prepare(
  `UPDATE subscriptions SET status = @status, updated_at = @now WHERE user_id = @userId`,
);

export const subscriptionsRepo = {
  get(userId: number): SubscriptionRow | undefined {
    return stmtGetSub.get(userId) as SubscriptionRow | undefined;
  },
  activate(
    userId: number,
    opts: { periodEnd: number | null; provider: string; ref: string | null },
  ): void {
    stmtUpsertSub.run({
      userId,
      status: 'active',
      periodEnd: opts.periodEnd,
      provider: opts.provider,
      ref: opts.ref,
      now: Date.now(),
    });
  },
  setStatus(userId: number, status: 'cancelled' | 'expired'): void {
    stmtSetSubStatus.run({ userId, status, now: Date.now() });
  },
};

export const tasksRepo = {
  add(
    userId: number,
    chatId: number,
    title: string,
    dueAt: number | null,
    followUpAt: number | null,
  ): void {
    stmtAddTask.run({ userId, chatId, title, dueAt, followUpAt, now: Date.now() });
  },
  listOpen(userId: number): TaskRow[] {
    return stmtOpenTasks.all(userId) as TaskRow[];
  },
  /** Открытые задачи со сроком не позже ts (просроченные + на сегодня). */
  dueBy(userId: number, ts: number): TaskRow[] {
    return stmtTasksDueBy.all(userId, ts) as TaskRow[];
  },
  /** Отмечает выполненной первую открытую задачу, чей текст содержит подстроку. */
  complete(userId: number, titlePart: string): string | null {
    const row = stmtFindOpenTask.get(userId, `%${titlePart.trim()}%`) as
      | { id: number; title: string }
      | undefined;
    if (!row) return null;
    stmtCompleteTask.run(row.id);
    return row.title;
  },
  getDueFollowUps(now: number): DueFollowUp[] {
    return stmtDueFollowUps.all(now) as DueFollowUp[];
  },
  markFollowedUp(id: number): void {
    stmtMarkFollowedUp.run(id);
  },
};
