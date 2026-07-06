import Database from 'better-sqlite3';
import { config } from '../config';
import { logger } from '../logger';

export const db = new Database(config.dbPath);

// WAL повышает надёжность при частых записях (напоминания + история диалога).
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Встроенный SQL lower() работает только с ASCII, поэтому регистрируем
// корректную для Unicode функцию — нужна для регистронезависимого сравнения
// имён контактов на кириллице/казахском.
db.function('unicode_lower', { deterministic: true }, (value: unknown) =>
  value == null ? null : String(value).toLowerCase(),
);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  user_id         INTEGER PRIMARY KEY,
  chat_id         INTEGER NOT NULL,
  language        TEXT    NOT NULL DEFAULT 'ru',
  language_locked INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL,
  role       TEXT    NOT NULL,
  content    TEXT    NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_user ON messages(user_id, id);

CREATE TABLE IF NOT EXISTS reminders (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL,
  chat_id    INTEGER NOT NULL,
  text       TEXT    NOT NULL,
  remind_at  INTEGER NOT NULL,
  sent       INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders(sent, remind_at);

CREATE TABLE IF NOT EXISTS notes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL,
  text       TEXT    NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS contacts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL,
  name       TEXT    NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(user_id, name)
);

CREATE TABLE IF NOT EXISTS contact_notes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id INTEGER NOT NULL,
  note       TEXT    NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_contact_notes ON contact_notes(contact_id, id);

CREATE TABLE IF NOT EXISTS profile_facts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL,
  fact       TEXT    NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_profile_user ON profile_facts(user_id, id);

CREATE TABLE IF NOT EXISTS tasks (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL,
  chat_id      INTEGER NOT NULL,
  title        TEXT    NOT NULL,
  due_at       INTEGER,
  follow_up_at INTEGER,
  followed_up  INTEGER NOT NULL DEFAULT 0,
  status       TEXT    NOT NULL DEFAULT 'open',
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_user ON tasks(user_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_followup ON tasks(followed_up, follow_up_at);

CREATE TABLE IF NOT EXISTS google_tokens (
  user_id    INTEGER PRIMARY KEY,
  tokens     TEXT    NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS composio_connections (
  user_id    INTEGER NOT NULL,
  toolkit    TEXT    NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(user_id, toolkit)
);
`;

// Схему применяем сразу при загрузке модуля — до того, как репозитории
// (которые импортируют этот модуль) подготовят prepared statements.
db.exec(SCHEMA);

// Мягкая миграция: добавляем недостающие колонки в существующую таблицу users
// (SQLite не поддерживает ADD COLUMN IF NOT EXISTS).
function ensureColumn(table: string, column: string, ddl: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}
ensureColumn('users', 'briefing_enabled', 'briefing_enabled INTEGER NOT NULL DEFAULT 1');
ensureColumn('users', 'briefing_hour', 'briefing_hour INTEGER NOT NULL DEFAULT 9');
ensureColumn('users', 'last_briefing_date', 'last_briefing_date TEXT');
ensureColumn('users', 'username', 'username TEXT');
ensureColumn('users', 'first_name', 'first_name TEXT');
// Режим голосовых ответов: 'off' | 'reply' (только на голосовые) | 'always'.
ensureColumn('users', 'voice_mode', "voice_mode TEXT NOT NULL DEFAULT 'off'");
db.exec('CREATE INDEX IF NOT EXISTS idx_users_username ON users(username)');

/** Явная инициализация для точки входа: гарантирует загрузку модуля и пишет лог. */
export function initDb(): void {
  logger.info({ dbPath: config.dbPath }, 'База данных инициализирована');
}
