// 블록 안에서 글자 찾기. 뷰어가 열 때 뽑아 둔 블록에서 찾는다(UI 없는 순수 함수).
// 범위는 블록(표는 칸) 텍스트 안 글자 위치(유니코드 글자 단위, rhwp 와 같음)다. 시작은 0부터, 끝은 포함하지 않는다.
// 표 칸 텍스트는 칸 안 문단을 \n 으로 이은 것이라 \n 도 한 글자로 센다.
import { z } from 'zod';
import { textBlockPositionSchema, type Block } from './block-schema.ts';
import { charIndexes } from './chars.ts';

/** 일치 앞뒤로 보여주는 글자 수 */
export const CONTEXT_CHARS = 20;

export const textMatchSchema = z.object({
  block: textBlockPositionSchema,
  /** 표 칸 안 일치면 칸(0부터) */
  cell: z.object({ row: z.number(), col: z.number() }).optional(),
  start: z.number(),
  end: z.number(),
  before: z.string(),
  after: z.string(),
});
export type TextMatch = z.infer<typeof textMatchSchema>;

type TextMatchRange = Pick<TextMatch, 'start' | 'end' | 'before' | 'after'>;

/**
 * text 안에서 query 와 일치하는 곳을 앞에서부터 겹치지 않게 모두 찾는다. 위치·앞뒤 글자는 유니코드 글자 단위(core/chars.ts).
 * 문자열 검색 위치를 글자 위치 표로 바꿔서 text 길이에 비례해 끝난다
 */
function matchesIn(text: string, query: string): TextMatchRange[] {
  const found: TextMatchRange[] = [];
  const chars = [...text];
  const charAt = charIndexes(text);
  for (let at = text.indexOf(query); at !== -1; at = text.indexOf(query, at + query.length)) {
    const start = charAt[at] ?? 0;
    const end = charAt[at + query.length] ?? chars.length;
    found.push({
      start,
      end,
      before: chars.slice(Math.max(0, start - CONTEXT_CHARS), start).join(''),
      after: chars.slice(end, end + CONTEXT_CHARS).join(''),
    });
  }
  return found;
}

/**
 * 문단·표 칸에서 query 를 찾는다. 누름틀 블록은 따로 찾지 않는다
 * (누름틀 값은 그 누름틀이 든 문단·칸 텍스트에 들어 있어 거기서 찾힌다).
 */
export function findInBlocks(blocks: Block[], query: string): TextMatch[] {
  if (query.length === 0) return [];
  return blocks.flatMap((block): TextMatch[] => {
    switch (block.kind) {
      case 'paragraph': {
        const position = textBlockPositionSchema.parse(block);
        return matchesIn(block.text, query).map((range) => ({ block: position, ...range }));
      }
      case 'table': {
        const position = textBlockPositionSchema.parse(block);
        return block.cells.flatMap(({ row, col, text }) =>
          matchesIn(text, query).map((range) => ({ block: position, cell: { row, col }, ...range })),
        );
      }
      case 'field':
        return [];
    }
  });
}
