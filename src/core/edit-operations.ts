// 편집 종류(SPEC-002 편집 도구)와 rhwp 문서에 적용하기. 뷰어와 테스트 뷰어가 같이 쓴다(document-editor.ts 가 부른다).
// 편집은 kind 로 가르는 판별 유니언이다. 새 편집(#20 넣기·지우기, #21 옮기기)은
// 1) editOperationSchema 에 스키마 하나 2) applyEdit 의 switch 에 case 하나를 더한다(case 를 빠뜨리면 컴파일 오류).
// 대상 블록은 서버가 붙인 위치(anchor)로 지금 블록 목록에서 찾고, 범위·칸 검사는 블록 글자를 가진 여기서 한다.
import type { HwpDocument } from '@rhwp/core';
import { z } from 'zod';
import { blockIndexByAnchor, fieldOrdinal } from './block-ids.ts';
import { anchoredTargetSchema, type AnchoredTarget, type Block, type FieldBlock, type TableBlock } from './block-schema.ts';
import { spanIn, targetLabel } from './text-targets.ts';
import { listFields, replaceCellText, replaceFieldText, replaceParagraphText } from './edits.ts';

export const replaceTextOperationSchema = z.object({
  kind: z.literal('replace_text'),
  target: anchoredTargetSchema,
  text: z.string(),
});

/** 뷰어가 적용하는 편집. kind 마다 입력이 다르다 */
export const editOperationSchema = z.discriminatedUnion('kind', [replaceTextOperationSchema]);
export type EditOperation = z.infer<typeof editOperationSchema>;
export type ReplaceTextOperation = z.infer<typeof replaceTextOperationSchema>;

/** 본문 문단 위치 */
export interface ParagraphPosition {
  section: number;
  paragraph: number;
}

/**
 * 편집이 바꾼 본문 문단(편집 뒤 위치). 그 문단에 걸린 블록(문단 글자·표·누름틀)을 모두 바뀐 블록으로 본다 —
 * 누름틀 값을 바꾸면 같은 문단 글자도, 문단 글자를 바꾸면 그 안 누름틀도 바뀌기 때문이다(PR #26 리뷰)
 */
export interface EditApplied {
  paragraphs: ParagraphPosition[];
}

/** 편집은 빈 범위(start = end)를 그 자리에 넣기로 받는다 */
const EDIT_SPAN = { allowEmpty: true };

function blockAt(blocks: Block[], target: AnchoredTarget): Block {
  const index = blockIndexByAnchor(blocks)(target.anchor);
  const block = index === undefined ? undefined : blocks[index];
  if (block === undefined) throw new Error(`${target.id}: 뷰어 문서에 이 블록이 없습니다. get_outline 을 다시 부르세요.`);
  return block;
}

function replaceInTable(doc: HwpDocument, block: TableBlock, target: AnchoredTarget, text: string): void {
  if (target.cell === undefined) throw new Error(`${target.id}: 표 블록은 cell 로 바꿀 칸을 고르세요.`);
  const { row, col } = target.cell;
  const cellIndex = block.cells.findIndex((cell) => cell.row === row && cell.col === col);
  if (cellIndex === -1) {
    throw new Error(
      `${target.id}: 표에 없는 칸입니다(row ${row}, col ${col}). 이 표는 ${block.rowCount}행 ${block.colCount}열이고, 합친 칸은 왼쪽 위 칸 좌표로 고릅니다(read_blocks 의 cells).`,
    );
  }
  const { start, end } = spanIn(target, block.cells[cellIndex]?.text ?? '', EDIT_SPAN);
  assertSomethingToChange(target, start, end, text);
  const address = { section: block.section, paragraph: block.paragraph, controlIndex: block.controlIndex, cellIndex };
  replaceCellText(doc, address, text, start, end);
}

function replaceInField(doc: HwpDocument, block: FieldBlock, target: AnchoredTarget, text: string): void {
  if (target.cell !== undefined) throw new Error(`${target.id}: 표 블록이 아니라 cell 을 줄 수 없습니다.`);
  // 같은 문단의 몇 번째 누름틀인지는 서버가 보낸 위치에 있다(블록 추출이 getFieldList 순서를 따른다).
  // 이름은 겹칠 수 있어 fieldId 로 고른다(ADR 002)
  const ordinal = fieldOrdinal(target.anchor) ?? 0;
  const field = listFields(doc).filter(
    (candidate) => candidate.location.sectionIndex === block.section && candidate.location.paraIndex === block.paragraph,
  )[ordinal];
  if (field === undefined) throw new Error(`${target.id}: 뷰어 문서에서 이 누름틀을 찾지 못했습니다. get_outline 을 다시 부르세요.`);
  const path = field.location.path ?? [];
  if (path.length > 1 || path.some((step) => step.type !== 'cell')) {
    throw new Error(`${target.id}: 표 안 표나 글상자에 든 누름틀은 아직 바꿀 수 없습니다.`);
  }
  const { start, end } = spanIn(target, block.value, EDIT_SPAN);
  assertSomethingToChange(target, start, end, text);
  replaceFieldText(doc, field.fieldId, text, start, end);
}

function assertSomethingToChange(target: AnchoredTarget, start: number, end: number, text: string): void {
  if (start === end && text.length === 0) {
    throw new Error(`${targetLabel(target)}: 바꿀 것이 없습니다(빈 범위에 빈 글자). 지우려면 범위를, 넣으려면 글자를 주세요.`);
  }
}

/** replace_text: 대상 블록(칸·누름틀 값) 범위의 글자를 바꾼다. 글자 모양은 바뀌는 자리 첫 글자를 따른다(edits.ts) */
function replaceText(doc: HwpDocument, blocks: Block[], { target, text }: ReplaceTextOperation): EditApplied {
  // 줄바꿈 거부는 edits.ts 가 편집 전에 한다
  const block = blockAt(blocks, target);
  switch (block.kind) {
    case 'paragraph': {
      if (target.cell !== undefined) throw new Error(`${target.id}: 표 블록이 아니라 cell 을 줄 수 없습니다.`);
      const { start, end } = spanIn(target, block.text, EDIT_SPAN);
      assertSomethingToChange(target, start, end, text);
      replaceParagraphText(doc, block.section, block.paragraph, text, start, end);
      break;
    }
    case 'table':
      replaceInTable(doc, block, target, text);
      break;
    case 'field':
      replaceInField(doc, block, target, text);
      break;
  }
  return { paragraphs: [{ section: block.section, paragraph: block.paragraph }] };
}

/** 편집 하나를 문서에 적용한다. 던지면 문서가 반쯤 바뀌었을 수 있다 — 되돌리기는 부르는 쪽 스냅샷이 맡는다 */
export function applyEdit(doc: HwpDocument, blocks: Block[], operation: EditOperation): EditApplied {
  switch (operation.kind) {
    case 'replace_text':
      return replaceText(doc, blocks, operation);
    default: {
      // 편집 종류를 더하고 여기 처리를 빠뜨리면 컴파일 오류가 난다
      const unhandled: never = operation.kind;
      throw new Error(`처리하지 않는 편집입니다: ${String(unhandled)}`);
    }
  }
}
