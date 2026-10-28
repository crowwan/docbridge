// 문서 바이트 열기(뷰어 load_document·create_document 양식·테스트 뷰어 공용) — 줄 배치가 빠진 본문 문단을 다시 배치한다(#89).
import { HwpDocument } from '@rhwp/core';
import { z } from 'zod';
import { paraShapeIdOf } from './edits.ts';
import { parseJson } from './json.ts';

/** 경고가 난 자리: 본문 문단이면 cell 이 null, 표 칸 문단이면 칸 위치. rhwp 가 모양을 바꾸면(예: 본문에서 cell 을 빼면) 여기서 바로 던진다 */
const validationWarningsSchema = z.object({
  warnings: z.array(
    z.object({
      section: z.number(),
      paragraph: z.number(),
      kind: z.string(),
      cell: z.union([z.null(), z.object({ ctrl: z.number(), row: z.number(), col: z.number(), innerPara: z.number() })]),
    }),
  ),
});

/** 줄 배치(linesegarray) 없이 저장된 본문 문단(표 칸 문단은 뺀다) */
export function linelessParagraphs(doc: HwpDocument): Array<{ section: number; paragraph: number }> {
  const { warnings } = parseJson(validationWarningsSchema, doc.getValidationWarnings());
  return warnings
    .filter(({ kind, cell }) => kind === 'LinesegArrayEmpty' && cell === null)
    .map(({ section, paragraph }) => ({ section, paragraph }));
}

/**
 * 줄 배치 없이 저장된 본문 문단을 그 문서 폭으로 다시 배치한다. 없으면 아무것도 하지 않는다.
 * rhwp 는 열 때 이런 문단을 한 줄로 두어(한글은 열 때 다시 계산한다) 초록 표시·highlight·더블클릭 자리가 첫 줄 일부만 잡힌다.
 * docbridge 가 저장한 파일에서도 생긴다: rhwp 가 다시 배치한 줄 배치를 합성한 것으로 보고 빼고 저장한다(copy_blocks 로 넣은 문단, #85).
 *
 * 다시 배치는 reflowLinesegs() 한 번이다(15쪽 297문단에 +50ms 안). 문단마다 문단 모양을 다시 거는 방법(copy-paragraphs.ts relayout)은
 * 부를 때마다 구역을 다시 조판해 같은 문서에서 5초가 걸린다(ADR 004).
 * 다만 구역 첫 문단(구역 정의가 든 문단 — rhwp 가 저장한 HWPX 에서 자주 줄 배치가 빈다)이 줄 배치 없이 남은 채 reflowLinesegs() 를 부르면
 * 뒤 문단 vertpos 가 한 줄씩 밀린 채 저장된다(fixture 5개 중 3개, 화면은 같다). 그래서 그 문단만 먼저 문단 모양을 같은 번호로 다시 건다
 * — 그러면 저장 결과가 그냥 연 것과 같다
 */
function relayoutLinelessParagraphs(doc: HwpDocument): void {
  const paragraphs = linelessParagraphs(doc);
  if (paragraphs.length === 0) return;
  // 구역마다 첫 문단(paragraph 0). 머리말·꼬리말 문단은 이 경고 목록에 나오지 않는다(fixture sections.hwpx 로 확인)
  for (const { section, paragraph } of paragraphs) {
    if (paragraph === 0) doc.setParaShapeId(section, paragraph, paraShapeIdOf(doc, section, paragraph));
  }
  doc.reflowLinesegs();
}

/** 파일 바이트를 rhwp 로 열고 줄 배치가 빠진 문단을 다시 배치한다. 읽지 못하면 던진다 */
export function openHwpDocument(bytes: Uint8Array): HwpDocument {
  const doc = new HwpDocument(bytes);
  try {
    relayoutLinelessParagraphs(doc);
    return doc;
  } catch (error) {
    doc.free();
    throw error;
  }
}
