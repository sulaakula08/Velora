/**
 * Поля схемы, которые понимает Gemini (function declarations). Всё остальное
 * (title, examples, default, additionalProperties, $schema, pattern, format...)
 * выкидываем — иначе generateContent падает на «Unknown name». Это важно для
 * «жирных» схем Composio, где таких полей много.
 */
const ALLOWED_KEYS = new Set([
  'type',
  'description',
  'nullable',
  'enum',
  'properties',
  'required',
  'items',
  'anyOf',
  'minItems',
  'maxItems',
  'minimum',
  'maximum',
]);

/**
 * Конвертирует JSON Schema в формат схемы Gemini: типы приводятся к верхнему
 * регистру (STRING/OBJECT/ARRAY...), вложенные properties/items/anyOf —
 * рекурсивно, неподдерживаемые поля отбрасываются.
 */
export function toGeminiSchema(schema: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'type') {
      // type может быть строкой или массивом (напр. ['string','null']).
      const t = Array.isArray(value)
        ? value.find((v) => typeof v === 'string' && v !== 'null')
        : value;
      if (typeof t === 'string') out.type = t.toUpperCase();
    } else if (key === 'properties' && value && typeof value === 'object') {
      out.properties = {};
      for (const [propKey, propVal] of Object.entries(value as Record<string, any>)) {
        out.properties[propKey] = toGeminiSchema(propVal as Record<string, any>);
      }
    } else if (key === 'items' && value && typeof value === 'object') {
      out.items = toGeminiSchema(value as Record<string, any>);
    } else if (key === 'anyOf' && Array.isArray(value)) {
      out.anyOf = value.map((v) => toGeminiSchema(v as Record<string, any>));
    } else if (ALLOWED_KEYS.has(key)) {
      out[key] = value;
    }
    // остальные ключи молча отбрасываем
  }
  return out;
}
