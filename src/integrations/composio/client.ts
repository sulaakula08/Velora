import { Composio } from '@composio/core';
import { config } from '../../config';

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
  { slug: 'slack', name: 'Slack' },
  { slug: 'notion', name: 'Notion' },
  { slug: 'github', name: 'GitHub' },
  { slug: 'linear', name: 'Linear' },
];

/** id auth-конфига (из дашборда Composio) для тулкита, если задан в .env. */
export function authConfigFor(slug: string): string | undefined {
  return config.composioAuthConfigs[slug];
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
