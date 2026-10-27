// 누름틀 값 자리(SPEC-005): 누름틀 값은 그 누름틀이 든 문단(표 칸) 글자 안에 있다. 그 글자 블록 안에서 값이 차지한 [start, end) 를 다룬다.
// 찾아 바꾸기(replace_all, 서버)는 값에 걸친 일치를 빼고, replace_text 편집(뷰어)은 값에 걸친 문단·칸 자리를 거부한다 — 같은 판정을 쓴다.
import type { Block, FieldSpan } from './block-schema.ts';

/** 글자 블록 하나: 본문 문단 글자, 또는 cell 이 있으면 그 문단 표의 칸 글자 */
export interface TextPlace {
  section: number;
  paragraph: number;
  cell?: FieldSpan['cell'];
}

export interface CharRange {
  start: number;
  end: number;
}

const sameCell = (a: TextPlace['cell'], b: TextPlace['cell']) =>
  a === undefined || b === undefined ? a === b : a.controlIndex === b.controlIndex && a.row === b.row && a.col === b.col;

/** 그 글자 블록 안 누름틀 값 자리(블록 추출이 붙인 span) */
export function fieldSpansIn(blocks: Block[], place: TextPlace): CharRange[] {
  return blocks.flatMap((block) =>
    block.kind === 'field' &&
    block.section === place.section &&
    block.paragraph === place.paragraph &&
    block.span !== undefined &&
    sameCell(block.span.cell, place.cell)
      ? [block.span]
      : [],
  );
}

/**
 * 범위가 누름틀 값 자리에 걸치는지. 글자가 겹치거나 빈 값 자리를 가로지르면, 빈 범위(넣기)는 값 안쪽이면 걸친다.
 * 값 바로 앞·뒤에 넣기와 맞닿은 범위는 걸치지 않는다(값 밖에 들어간다)
 */
export function crossesField({ start, end }: CharRange, field: CharRange): boolean {
  return start < end ? start < field.end && field.start < end : field.start < start && start < field.end;
}
