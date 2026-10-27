// 누름틀 목록(getFieldList). 블록 추출(blocks.ts)·편집(edits.ts)·지우기(delete-blocks.ts)가 같은 스키마와 "표 안" 판정을 쓴다.
import type { HwpDocument } from '@rhwp/core';
import { z } from 'zod';
import { parseJson } from './json.ts';

// location.path 한 칸. 표 칸은 칸 번호가 있고, 글상자 등 칸이 아닌 자리는 칸 번호가 없다
// ({type:"textbox", controlIndex, paraIndex}, #42). 칸이 아닌 자리는 종류와 컨트롤 번호만 읽는다
const cellPathStepSchema = z.object({ type: z.literal('cell'), controlIndex: z.number(), cellIndex: z.number(), paraIndex: z.number() });
const otherPathStepSchema = z.object({ type: z.string(), controlIndex: z.number() });
const pathStepSchema = z.union([cellPathStepSchema, otherPathStepSchema]);

export type CellPathStep = z.infer<typeof cellPathStepSchema>;
export type FieldPathStep = z.infer<typeof pathStepSchema>;

const clickHereSchema = z.object({
  fieldId: z.number(),
  fieldType: z.literal('clickhere'),
  name: z.string(),
  guide: z.string(),
  value: z.string(),
  startCharIdx: z.number(),
  endCharIdx: z.number(),
  location: z.object({
    sectionIndex: z.number(),
    paraIndex: z.number(),
    path: z.array(pathStepSchema).optional(),
  }),
});
// 하이퍼링크 등 누름틀이 아닌 필드는 종류만 읽는다(모양이 달라도 던지지 않는다, #42). 누름틀 모양이 틀리면 둘 다 맞지 않아 던진다
const otherFieldSchema = z.looseObject({ fieldType: z.string().refine((type) => type !== 'clickhere') });
const fieldListSchema = z.array(z.union([clickHereSchema, otherFieldSchema]));

export type FieldInfo = z.infer<typeof clickHereSchema>;
type ListedField = z.infer<typeof fieldListSchema>[number];

const isClickHere = (field: ListedField): field is FieldInfo => field.fieldType === 'clickhere';

/** 표 칸 단계인지(글상자 등은 칸 번호가 없다) */
export const isCellStep = (step: FieldPathStep): step is CellPathStep => step.type === 'cell' && 'cellIndex' in step;

/** 누름틀이 든 본문 표의 컨트롤 번호. 문단 직속·글상자 안이면 undefined(글상자 컨트롤 번호를 표로 보지 않는다) */
export function fieldTableIndex(path: FieldPathStep[] | undefined): number | undefined {
  const first = path?.[0];
  return first !== undefined && isCellStep(first) ? first.controlIndex : undefined;
}

/** 문서의 누름틀(getFieldList 순서) */
export function listFields(doc: HwpDocument): FieldInfo[] {
  return parseJson(fieldListSchema, doc.getFieldList()).filter(isClickHere);
}
