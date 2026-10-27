// 편집 종류(SPEC-002 편집 도구)와 rhwp 문서에 적용하기. 뷰어와 테스트 뷰어가 같이 쓴다(document-editor.ts 가 부른다).
// 편집은 kind 로 가르는 판별 유니언이다. 새 편집은
// 1) editOperationSchema 에 스키마 하나 2) applyEdit 의 switch 에 case 하나를 더한다(case 를 빠뜨리면 컴파일 오류).
// 대상 블록은 서버가 붙인 위치(anchor)로 지금 블록 목록에서 찾고, 범위·칸 검사는 블록 글자를 가진 여기서 한다.
import type { HwpDocument } from '@rhwp/core';
import { z } from 'zod';
import { blockIndexByAnchor, fieldOrdinal } from './block-ids.ts';
import { anchoredTargetSchema, blockAnchorSchema, type AnchoredTarget, type Block, type FieldBlock, type TableBlock } from './block-schema.ts';
import { deleteBlocks } from './delete-blocks.ts';
import { insertParagraphNear, listFields, moveParagraphs, replaceCellText, replaceFieldText, replaceParagraphText } from './edits.ts';
import { noParagraphChanges, type ParagraphChanges, type ParagraphPosition } from './paragraph-changes.ts';
import { spanIn, targetLabel } from './text-targets.ts';

export type { ParagraphPosition } from './paragraph-changes.ts';

export const replaceTextOperationSchema = z.object({
  kind: z.literal('replace_text'),
  target: anchoredTargetSchema,
  text: z.string(),
});

/** 서버가 id 를 id 표 위치로 바꿔 붙인 블록(글자 범위 없이 블록 하나) */
const anchoredBlockSchema = anchoredTargetSchema.pick({ id: true, anchor: true });
export type AnchoredBlock = z.infer<typeof anchoredBlockSchema>;

export const insertParagraphOperationSchema = z.object({
  kind: z.literal('insert_paragraph'),
  /** 기준 블록. 표·누름틀이면 그것이 든 문단이 기준이다 */
  reference: anchoredBlockSchema,
  where: z.enum(['before', 'after']),
  text: z.string(),
});

export const deleteBlocksOperationSchema = z.object({
  kind: z.literal('delete_blocks'),
  targets: z.array(anchoredBlockSchema).min(1),
});

const paragraphIndexSchema = z.number().int().min(0);

/**
 * move_blocks: 같은 구역 안 이어진 문단 [start, end) 를 before 문단 앞으로 옮긴다.
 * 이어짐·기준 위치 등은 서버가 id 표로 검사해 범위를 정해 보낸다(server/move-plan.ts).
 * blocks 는 그 범위에 든 블록 모두(문서 순서) — 뷰어 블록과 맞는지 확인하고, 거부 문구에 id 를 쓴다
 */
export const moveBlocksOperationSchema = z.object({
  kind: z.literal('move_blocks'),
  section: paragraphIndexSchema,
  start: paragraphIndexSchema,
  end: paragraphIndexSchema,
  before: paragraphIndexSchema,
  blocks: z.array(z.object({ id: z.string(), anchor: blockAnchorSchema })).min(1),
});

/** 뷰어가 적용하는 편집. kind 마다 입력이 다르다 */
export const editOperationSchema = z.discriminatedUnion('kind', [
  replaceTextOperationSchema,
  insertParagraphOperationSchema,
  deleteBlocksOperationSchema,
  moveBlocksOperationSchema,
]);
export type EditOperation = z.infer<typeof editOperationSchema>;
export type ReplaceTextOperation = z.infer<typeof replaceTextOperationSchema>;
export type InsertParagraphOperation = z.infer<typeof insertParagraphOperationSchema>;
export type DeleteBlocksOperation = z.infer<typeof deleteBlocksOperationSchema>;
export type MoveBlocksOperation = z.infer<typeof moveBlocksOperationSchema>;

/**
 * 편집이 바꾼 본문 문단(편집 뒤 위치). 그 문단에 걸린 블록(문단 글자·표·누름틀)을 모두 바뀐 블록으로 본다 —
 * 누름틀 값을 바꾸면 같은 문단 글자도, 문단 글자를 바꾸면 그 안 누름틀도 바뀌기 때문이다(PR #26 리뷰).
 * changes 는 문단 수를 바꾼 편집이 실제로 한 일(넣은 문단·지운 문단·표, paragraph-changes.ts) — 뷰어가 서버에 돌려준다
 */
export interface EditApplied {
  paragraphs: ParagraphPosition[];
  changes?: ParagraphChanges;
}

/** 편집은 빈 범위(start = end)를 그 자리에 넣기로 받는다 */
const EDIT_SPAN = { allowEmpty: true };

function blockAt(blocks: Block[], target: AnchoredBlock): Block {
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

/** insert_paragraph: 기준 블록이 든 문단 앞·뒤에 새 문단을 넣는다. 서식은 기준 문단을 따른다(edits.ts insertParagraphNear) */
function insertParagraph(doc: HwpDocument, blocks: Block[], { reference, where, text }: InsertParagraphOperation): EditApplied {
  // 표 칸 안 문단은 블록이 아니므로 기준은 언제나 본문 문단이다(표·누름틀 블록이면 그것을 품은 문단). 줄바꿈 거부는 edits.ts
  const { section, paragraph } = blockAt(blocks, reference);
  const position = { section, paragraph: insertParagraphNear(doc, section, paragraph, where, text) };
  return { paragraphs: [position], changes: { ...noParagraphChanges(), inserted: [position] } };
}

export const moveRejectedMessage = (reason: string, label: string) =>
  `이 문단은 옮길 수 없습니다(${reason}): ${label}. 글자만 옮기려면 insert_paragraph 와 delete_blocks 를 쓰세요.`;

/**
 * move_blocks: 서식째(표·누름틀 포함) 옮긴다(edits.ts moveParagraphs — 사본·dryRun·번호 문단 모양 되돌리기).
 * rhwp 가 거부하면 거부된 문단마다 스펙 문구를 모아 던진다(문서는 바뀌지 않았고, 스냅샷 복원 뒤 기록에도 남지 않는다).
 * 실제로 옮긴 범위를 changes.moved 로 돌려준다 — 서버 id 표와 남길 빈 문단 위치가 이것으로 옮겨진다
 */
function moveBlocks(doc: HwpDocument, blocks: Block[], { section, start, end, before, blocks: moving }: MoveBlocksOperation): EditApplied {
  const indexOf = blockIndexByAnchor(blocks);
  for (const { id, anchor } of moving) {
    const inRange = anchor.section === section && start <= anchor.paragraph && anchor.paragraph < end;
    if (indexOf(anchor) === undefined || !inRange) throw new Error(`${id}: 뷰어 문서에 이 블록이 없습니다. get_outline 을 다시 부르세요.`);
  }
  const result = moveParagraphs(doc, section, start, end, before);
  if (!result.ok) {
    // 거부된 문단의 첫 블록 id. 블록이 없는 빈 문단이면 바로 앞 블록 뒤라고 적는다(범위 첫 문단에는 늘 블록이 있다)
    const label = (paragraph: number) => {
      const own = moving.find(({ anchor }) => anchor.paragraph === paragraph);
      if (own !== undefined) return own.id;
      const previous = moving.filter(({ anchor }) => anchor.paragraph < paragraph).at(-1);
      return `${previous?.id ?? `문단 ${paragraph}`} 뒤 빈 문단`;
    };
    throw new Error(result.rejected.map(({ paragraph, reason }) => moveRejectedMessage(reason, label(paragraph))).join('\n'));
  }
  return {
    paragraphs: Array.from({ length: end - start }, (_, i) => ({ section, paragraph: result.moved.start + i })),
    changes: { ...noParagraphChanges(), moved: { section, start, end, before } },
  };
}

/** 편집 하나를 문서에 적용한다. 던지면 문서가 반쯤 바뀌었을 수 있다 — 되돌리기는 부르는 쪽 스냅샷이 맡는다 */
export function applyEdit(doc: HwpDocument, blocks: Block[], operation: EditOperation): EditApplied {
  switch (operation.kind) {
    case 'replace_text':
      return replaceText(doc, blocks, operation);
    case 'insert_paragraph':
      return insertParagraph(doc, blocks, operation);
    case 'delete_blocks':
      return { paragraphs: [], changes: deleteBlocks(doc, blocks, operation.targets) };
    case 'move_blocks':
      return moveBlocks(doc, blocks, operation);
    default: {
      // 편집 종류를 더하고 여기 처리를 빠뜨리면 컴파일 오류가 난다
      const unhandled: never = operation;
      throw new Error(`처리하지 않는 편집입니다: ${JSON.stringify(unhandled)}`);
    }
  }
}
