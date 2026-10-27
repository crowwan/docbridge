// 블록(본문 문단·표·누름틀)의 모양. 뷰어가 뽑고 서버가 읽으므로 zod 스키마 하나에서 타입을 만든다.
import { z } from 'zod';

export const paragraphBlockSchema = z.object({
  kind: z.literal('paragraph'),
  section: z.number(),
  paragraph: z.number(),
  /** 1부터 시작하는 쪽 번호 */
  page: z.number(),
  text: z.string(),
  /** 자동 번호(문단 번호·개요 번호) 문단이면 화면에 그려지는 번호 문자열 */
  number: z.string().optional(),
  /** 개요 문단이면 개요 수준(1부터) */
  outlineLevel: z.number().optional(),
});

export const tableCellSchema = z.object({
  row: z.number(),
  col: z.number(),
  /** 칸 안 문단들을 줄바꿈(\n)으로 이은 텍스트 */
  text: z.string(),
  /** 같은 행 첫 칸의 텍스트(칸 라벨) */
  rowLabel: z.string(),
});

export const tableBlockSchema = z.object({
  kind: z.literal('table'),
  section: z.number(),
  /** 표를 품은 본문 문단 */
  paragraph: z.number(),
  controlIndex: z.number(),
  page: z.number(),
  rowCount: z.number(),
  colCount: z.number(),
  cells: z.array(tableCellSchema),
});

export const fieldBlockSchema = z.object({
  kind: z.literal('field'),
  section: z.number(),
  /** 누름틀이 있는 본문 문단(표 안이면 표를 품은 문단) */
  paragraph: z.number(),
  page: z.number(),
  name: z.string(),
  guide: z.string(),
  value: z.string(),
  inTable: z.boolean(),
});

export const blockSchema = z.discriminatedUnion('kind', [paragraphBlockSchema, tableBlockSchema, fieldBlockSchema]);

export type ParagraphBlock = z.infer<typeof paragraphBlockSchema>;
export type TableCell = z.infer<typeof tableCellSchema>;
export type TableBlock = z.infer<typeof tableBlockSchema>;
export type FieldBlock = z.infer<typeof fieldBlockSchema>;
export type Block = z.infer<typeof blockSchema>;

const paragraphPositionSchema = paragraphBlockSchema.pick({ kind: true, section: true, paragraph: true });
const tablePositionSchema = tableBlockSchema.pick({ kind: true, section: true, paragraph: true, controlIndex: true });

/** id 를 붙이는 데 필요한 블록 위치. 블록을 이 스키마로 읽으면 나머지 필드는 떨어진다 */
export const blockPositionSchema = z.discriminatedUnion('kind', [
  paragraphPositionSchema,
  tablePositionSchema,
  fieldBlockSchema.pick({ kind: true, section: true, paragraph: true }),
]);
export type BlockPosition = z.infer<typeof blockPositionSchema>;

/** 글자를 찾을 수 있는 블록(문단·표)의 위치 */
export const textBlockPositionSchema = z.discriminatedUnion('kind', [paragraphPositionSchema, tablePositionSchema]);
export type TextBlockPosition = z.infer<typeof textBlockPositionSchema>;

/** 서버 id 표가 기억하는 블록 위치(block-ids.ts BlockAnchor). 뷰어가 이것으로 자기 블록을 찾는다 */
export const blockAnchorSchema = z.object({ section: z.number(), paragraph: z.number(), part: z.string() });

/**
 * 하이라이트·찾기 공용 대상(#6 find_text 결과, #7 highlight 입력).
 * 글자 위치는 read_blocks 가 돌려주는 블록 text(표는 칸 안 문단을 \n 으로 이은 칸 text) 안 유니코드 글자 위치다
 * (JS 문자열 위치가 아니다. 이모지·확장 한자도 한 글자 — core/chars.ts).
 */
export const textTargetSchema = z.object({
  /** 블록 id */
  id: z.string(),
  /** 표 블록일 때 칸(0부터). 표 블록인데 없으면 표 전체 */
  cell: z.object({ row: z.number().int().min(0), col: z.number().int().min(0) }).optional(),
  /** 블록(또는 칸) 텍스트 안 시작 글자 위치. 0부터, 포함 */
  start: z.number().int().min(0).optional(),
  /** 끝 글자 위치, 미포함. start·end 둘 다 없으면 블록(칸) 전체 */
  end: z.number().int().min(0).optional(),
});
export type TextTarget = z.infer<typeof textTargetSchema>;

/** 서버가 id 를 id 표의 위치로 바꿔 붙인 대상(뷰어로 보내는 하이라이트·편집 대상) */
export const anchoredTargetSchema = textTargetSchema.extend({ anchor: blockAnchorSchema });
export type AnchoredTarget = z.infer<typeof anchoredTargetSchema>;
