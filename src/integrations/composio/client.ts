import { Composio } from '@composio/core';
import { config } from '../../config';
import { logger } from '../../logger';

/** Настроена ли интеграция Composio (задан ли API-ключ). */
export function isComposioConfigured(): boolean {
  return Boolean(config.composioApiKey);
}

let client: Composio | null = null;

export function composio(): Composio {
  if (!client) client = new Composio({ apiKey: config.composioApiKey });
  return client;
}

export interface SupportedApp {
  slug: string; // slug тулкита в Composio
  name: string; // человекочитаемое имя
}

/** Приложения, которые бот предлагает подключить. Расширяется одной строкой. */
export const SUPPORTED_APPS: SupportedApp[] = [
  { slug: 'gmail', name: 'Gmail' },
  { slug: 'googlecalendar', name: 'Google Календарь' },
  { slug: 'googlemeet', name: 'Google Meet' },
  { slug: 'googledocs', name: 'Google Docs' },
  { slug: 'googlesheets', name: 'Google Sheets' },
  { slug: 'googleslides', name: 'Google Slides' },
  { slug: 'telegram', name: 'Telegram' },
  { slug: 'slack', name: 'Slack' },
  { slug: 'notion', name: 'Notion' },
  { slug: 'github', name: 'GitHub' },
  { slug: 'linear', name: 'Linear' },
];

// Карта slug → auth_config_id, подтянутая из Composio при старте. Избавляет от
// необходимости прописывать COMPOSIO_AUTH_CONFIGS вручную: любой включённый
// auth-конфиг в дашборде Composio автоматически становится доступным в боте.
let dynamicAuthConfigs: Record<string, string> = {};

/**
 * Загружает список включённых auth-конфигов из Composio и строит карту slug→id.
 * Вызывается при старте. При ошибке молча используем значения из .env (fallback).
 */
export async function loadAuthConfigs(): Promise<void> {
  try {
    const res: any = await (composio() as any).authConfigs.list();
    const items: any[] = res?.items ?? (Array.isArray(res) ? res : []);
    const map: Record<string, string> = {};
    for (const a of items) {
      const slug: string | undefined = a.toolkit?.slug ?? a.toolkitSlug ?? a.toolkit;
      const enabled = a.status ? a.status === 'ENABLED' : a.isDisabled !== true;
      if (slug && a.id && enabled) map[slug] = a.id;
    }
    dynamicAuthConfigs = map;
    logger.info({ apps: Object.keys(map) }, 'Auth-конфиги Composio загружены');
  } catch (err) {
    logger.warn({ err }, 'Не удалось загрузить auth-конфиги Composio — использую .env');
  }
}

/** id auth-конфига для тулкита: сперва из Composio, иначе из .env. */
export function authConfigFor(slug: string): string | undefined {
  return dynamicAuthConfigs[slug] ?? config.composioAuthConfigs[slug];
}

/** Приложения, реально доступные для подключения (у которых есть auth-конфиг). */
export function availableApps(): SupportedApp[] {
  return SUPPORTED_APPS.filter((app) => authConfigFor(app.slug));
}

/** Находит поддерживаемое приложение по slug или части имени. */
export function findApp(query: string): SupportedApp | undefined {
  const q = query.trim().toLowerCase();
  return availableApps().find((a) => a.slug === q || a.name.toLowerCase().includes(q));
}
