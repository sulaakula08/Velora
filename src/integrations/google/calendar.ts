import { google } from 'googleapis';
import type { GoogleClient } from './oauth';

export interface CalendarEvent {
  summary: string;
  start: string;
  end: string;
}

/** Список ближайших событий календаря в интервале [timeMin, timeMax]. */
export async function listEvents(
  client: GoogleClient,
  timeMin: string,
  timeMax: string,
): Promise<CalendarEvent[]> {
  const calendar = google.calendar({ version: 'v3', auth: client });
  const res = await calendar.events.list({
    calendarId: 'primary',
    timeMin,
    timeMax,
    singleEvents: true,
    orderBy: 'startTime',
    maxResults: 15,
  });
  return (res.data.items ?? []).map((e) => ({
    summary: e.summary ?? '(без названия)',
    start: e.start?.dateTime ?? e.start?.date ?? '',
    end: e.end?.dateTime ?? e.end?.date ?? '',
  }));
}

/** Создаёт событие в основном календаре. */
export async function createEvent(
  client: GoogleClient,
  params: { summary: string; start: string; end: string; description?: string },
): Promise<string> {
  const calendar = google.calendar({ version: 'v3', auth: client });
  const res = await calendar.events.insert({
    calendarId: 'primary',
    requestBody: {
      summary: params.summary,
      description: params.description,
      start: { dateTime: params.start },
      end: { dateTime: params.end },
    },
  });
  return res.data.htmlLink ?? 'создано';
}
