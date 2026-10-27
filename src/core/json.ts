// rhwp 가 돌려주는 JSON 문자열을 zod 스키마로 읽는다(타입 단언 없이, CLAUDE.md 규칙)
import type { z } from 'zod';

export function parseJson<T>(schema: z.ZodType<T>, json: string): T {
  return schema.parse(JSON.parse(json));
}
