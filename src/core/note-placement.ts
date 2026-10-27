// note 꼬리표 자리 정하기(#51). 원칙 "note 는 문서 글자를 덮지 않는다"(docs/design.md 컴포넌트 표, SPEC-001 하이라이트 절).
// 차례대로 고른다:
// 1. 위: 첫 대상 첫 사각형 바로 위. 그 자리가 쪽 안이고 쪽 글자 사각형(rhwp getPageTextLayout)과 겹치지 않을 때
// 2. 바깥 여백: 쪽 오른쪽 밖 회색 바탕, 첫 사각형과 같은 높이. 여백이 note 폭 이상이거나 최소 폭 이상일 때(좁으면 여백 폭에 맞춰 줄바꿈)
// 3. 아래: 첫 대상의 (첫 사각형과 같은 쪽) 마지막 사각형 바로 아래. 마지막 수단이라 글자와 겹칠 수 있다
// 좌표는 모두 쪽 왼쪽 위 기준 px(배율 1). DOM 을 모르는 순수 함수라 Vitest 로 본다.
import type { HwpDocument } from '@rhwp/core';
import { layoutSchema, type LayoutRun } from './highlight-targets.ts';
import { parseJson } from './json.ts';

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 기본 최대 폭(--note-max-width)으로 잰 note 크기 */
export interface NoteSize {
  width: number;
  height: number;
}

export interface NoteSpace {
  page: { width: number; height: number };
  /** 쪽 오른쪽 끝에서 보이는 화면 오른쪽 끝까지 폭(쪽 밖 회색 바탕). 쪽이 화면보다 넓으면 0 이하 */
  rightMargin: number;
  /** 그 쪽의 글자 사각형(textBoxes) */
  textBoxes: Box[];
}

export interface NotePlacementOptions {
  /** note 와 하이라이트·쪽 가장자리 사이 간격 */
  gap: number;
  /** 바깥 여백에 둘 때 note 최소 폭. 여백이 이보다 좁고 note 보다도 좁으면 여백에 두지 않는다 */
  minMarginWidth: number;
}

export type NotePlacement =
  | { side: 'above' | 'below'; x: number; y: number }
  /** width: 여백에서 쓸 폭(note 폭, 여백이 더 좁으면 여백 폭으로 줄바꿈). 쪽 밖은 남은 폭이 없어 폭을 정해 줘야 한다 */
  | { side: 'margin'; x: number; y: number; width: number };

const overlaps = (a: Box, b: Box) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

export function notePlacement(
  first: Box,
  last: Box,
  note: NoteSize,
  space: NoteSpace,
  { gap, minMarginWidth }: NotePlacementOptions,
): NotePlacement {
  // 위·아래에 둘 때는 첫 사각형 왼쪽 끝에 맞추되 쪽 밖으로 나가지 않게 한다
  const x = Math.max(0, Math.min(first.x, space.page.width - note.width));
  const above = { x, y: first.y - gap - note.height, width: note.width, height: note.height };
  if (above.y >= 0 && !space.textBoxes.some((text) => overlaps(above, text))) return { side: 'above', x, y: above.y };

  // 여백 양쪽(쪽 가장자리·화면 가장자리)에 간격을 둔다
  const marginWidth = space.rightMargin - 2 * gap;
  const margin = { side: 'margin', x: space.page.width + gap, y: first.y } as const;
  if (marginWidth >= note.width) return { ...margin, width: note.width };
  if (marginWidth >= minMarginWidth) return { ...margin, width: marginWidth };

  return { side: 'below', x, y: last.y + last.height + gap };
}

/** 쪽(0부터)의 글자 사각형. 하이라이트 사각형과 같은 rhwp 조판 결과다 */
export function pageTextBoxes(doc: HwpDocument, pageIndex: number): Box[] {
  return textBoxes(parseJson(layoutSchema, doc.getPageTextLayout(pageIndex)).runs);
}

/** 쪽 글자 배치에서 글자 사각형만. 빈 글자·공백만 있는 배치(빈 문단은 단 폭 전체로 나온다)는 뺀다 */
export function textBoxes(runs: Pick<LayoutRun, 'text' | 'x' | 'y' | 'w' | 'h'>[]): Box[] {
  return runs.filter((run) => run.text.trim() !== '').map((run) => ({ x: run.x, y: run.y, width: run.w, height: run.h }));
}
