import { spawn } from 'child_process';
import ffmpegPath from 'ffmpeg-static';
import { ai } from './client';
import { config } from '../config';
import { logger } from '../logger';

// Gemini TTS отдаёт «сырой» PCM (16-bit, моно, 24 кГц). Telegram для голосовых
// сообщений (sendVoice) требует OGG/Opus, поэтому конвертируем через ffmpeg.
const PCM_SAMPLE_RATE = 24000;

/** Убирает эмодзи, буллеты и лишние символы, которые TTS зачитал бы как мусор. */
function cleanForSpeech(text: string): string {
  return text
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}️]/gu, '')
    .replace(/^[•\-\*]\s*/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Кодирует PCM (s16le, 24 кГц, моно) в OGG/Opus для Telegram sendVoice. */
function pcmToOggOpus(pcm: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath) return reject(new Error('ffmpeg не найден (ffmpeg-static)'));
    const args = [
      '-f', 's16le', '-ar', String(PCM_SAMPLE_RATE), '-ac', '1', '-i', 'pipe:0',
      '-c:a', 'libopus', '-b:a', '32k', '-f', 'ogg', 'pipe:1',
    ];
    const ff = spawn(ffmpegPath, args, { stdio: ['pipe', 'pipe', 'ignore'] });
    const chunks: Buffer[] = [];
    ff.stdout.on('data', (c) => chunks.push(c));
    ff.on('error', reject);
    ff.on('close', (code) => {
      if (code === 0 && chunks.length) resolve(Buffer.concat(chunks));
      else reject(new Error(`ffmpeg завершился с кодом ${code}`));
    });
    ff.stdin.on('error', () => {}); // EPIPE, если ffmpeg упал раньше — игнорируем.
    ff.stdin.write(pcm);
    ff.stdin.end();
  });
}

/**
 * Синтезирует речь из текста и возвращает OGG/Opus-буфер для отправки как
 * голосовое сообщение. При любой ошибке возвращает null — вызывающий код тогда
 * просто оставит текстовый ответ.
 */
export async function synthesizeVoice(text: string): Promise<Buffer | null> {
  const clean = cleanForSpeech(text);
  if (!clean) return null;

  try {
    const res = await ai.models.generateContent({
      model: config.ttsModel,
      contents: [{ role: 'user', parts: [{ text: clean }] }],
      config: {
        responseModalities: ['AUDIO'],
        speechConfig: {
          voiceConfig: { prebuiltVoiceConfig: { voiceName: config.ttsVoice } },
        },
      },
    });

    const data = res.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
    if (!data) {
      logger.warn('TTS: модель не вернула аудио');
      return null;
    }
    return await pcmToOggOpus(Buffer.from(data, 'base64'));
  } catch (err) {
    logger.error({ err }, 'Не удалось синтезировать голос');
    return null;
  }
}
