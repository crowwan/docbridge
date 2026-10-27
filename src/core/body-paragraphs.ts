// 문서 전체 문단 번호 → (구역, 구역 안 문단). getControls 의 para 는 구역을 이어 붙인 문서 전체 문단 번호이고
// list 0 이 본문이다(구역마다 다른 목록이 아니다 — 여러 구역 한컴 문서로 확인, ADR 003).
// 구역 첫 문단 번호는 getParagraphCount 합으로 구한다. getSectionStarts 는 구역 정의(SectionDef) 표식이
// 든 문단까지 구역 시작으로 세서(구역 하나에 [0, 1] 이 나올 수 있다) 이 번호와 맞지 않는다(#6, 테스트).
import type { HwpDocument } from '@rhwp/core';
import { z } from 'zod';
import { parseJson } from './json.ts';
import { positionKey, type ParagraphPosition } from './paragraph-changes.ts';

/** 본문 목록(getControls 의 list) 번호 */
export const BODY_LIST = 0;

/** 지금 문서의 구역 시작으로 전체 문단 번호를 (구역, 문단)으로 바꾸는 함수. 문서 문단 수가 바뀌면 다시 만든다 */
type ParagraphCounts = Pick<HwpDocument, 'getParagraphCount' | 'getSectionCount'>;

export function bodyParagraphLocator(doc: ParagraphCounts): (globalParagraph: number) => ParagraphPosition {
  const starts: number[] = [];
  let total = 0;
  for (let section = 0; section < doc.getSectionCount(); section += 1) {
    starts.push(total);
    total += doc.getParagraphCount(section);
  }
  return (globalParagraph) => {
    const section = Math.max(0, starts.findLastIndex((start) => start <= globalParagraph));
    return { section, paragraph: globalParagraph - (starts[section] ?? 0) };
  };
}

const controlListSchema = z.array(
  z.object({ ctrlId: z.string(), userDesc: z.string(), list: z.number(), para: z.number(), controlIndex: z.number() }),
);

/** 본문 컨트롤과 그 구역 안 문단 위치(para 는 getControls 의 문서 전체 문단 번호 그대로 — deleteControlAt 등이 쓴다) */
export interface BodyControl extends ParagraphPosition {
  ctrlId: string;
  userDesc: string;
  list: number;
  para: number;
  controlIndex: number;
}

/** 본문(목록 0) 컨트롤을 문단 위치 키(positionKey)마다 문서 순서로 모은다. 표 칸·글상자 안 목록은 뺀다 */
export function bodyControlsAt(doc: ParagraphCounts & Pick<HwpDocument, 'getControls'>): Map<string, BodyControl[]> {
  const locate = bodyParagraphLocator(doc);
  const byParagraph = new Map<string, BodyControl[]>();
  for (const control of parseJson(controlListSchema, doc.getControls())) {
    if (control.list !== BODY_LIST) continue;
    const position = locate(control.para);
    const key = positionKey(position);
    const here = byParagraph.get(key);
    const located = { ...control, ...position };
    if (here === undefined) byParagraph.set(key, [located]);
    else here.push(located);
  }
  return byParagraph;
}
