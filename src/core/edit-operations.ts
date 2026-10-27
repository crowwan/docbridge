// 편집 종류(SPEC-002 편집 도구)와 rhwp 문서에 적용하기. 뷰어와 테스트 뷰어가 같이 쓴다(document-editor.ts 가 부른다).
// 편집은 kind 로 가르는 판별 유니언이다. 새 편집은
// 1) editOperationSchema 에 스키마 하나 2) applyEdit 의 switch 에 case 하나를 더한다(case 를 빠뜨리면 컴파일 오류).
// 대상 블록은 서버가 붙인 위치(anchor)로 지금 블록 목록에서 찾고, 범위·칸 검사는 블록 글자를 가진 여기서 한다.
import type { HwpDocument } from '@rhwp/core';
import { z } from 'zod';
import { anchorsOf, blockIndexByAnchor, fieldOrdinal, tablePart } from './block-ids.ts';
import { anchoredTargetSchema, blockAnchorSchema, type AnchoredTarget, type Block, type FieldBlock, type TableBlock } from './block-schema.ts';
import { insertTableParagraph } from './create-document.ts';
import { deleteBlocks } from './delete-blocks.ts';
import { isCellStep } from './fields.ts';
import { insertParagraphNear, listFields, moveParagraphs, replaceCellText, replaceFieldText, replaceParagraphText } from './edits.ts';
import { noParagraphChanges, positionKey, TEXT_PART, type ParagraphChanges, type ParagraphPosition } from './paragraph-changes.ts';
import { applyParagraphStyle, findStyle, resetToStyle } from './styles.ts';
import { spanIn, targetLabel } from './text-targets.ts';

export type { ParagraphPosition } from './paragraph-changes.ts';

/** 한 편집으로 바꾸는 자리 상한(SPEC-005) */
export const MAX_REPLACE_TARGETS = 500;

export const tooManyTargetsMessage = (count: number) =>
  `바꿀 자리가 ${count} 곳이라 너무 많습니다(${MAX_REPLACE_TARGETS} 까지). 여러 번으로 나눠 주세요.`;

/** 바꿀 자리 수가 상한을 넘으면 던진다. 서버는 뷰어에 보내기 전에, 뷰어는 적용하기 전에 같은 것으로 거부한다 */
export function assertTargetCount(count: number): void {
  if (count > MAX_REPLACE_TARGETS) throw new Error(tooManyTargetsMessage(count));
}

/**
 * replace_text: 자리(targets) 모두를 text 로 바꾼다. 한 자리여도 배열이다(SPEC-005).
 * 위치는 모두 편집 전 문서 기준이고, 하나라도 틀리거나 겹치면 아무것도 바꾸지 않는다
 */
export const replaceTextOperationSchema = z.object({
  kind: z.literal('replace_text'),
  targets: z.array(anchoredTargetSchema).min(1),
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
  /** 문단 스타일 이름(한글·영문). 주면 새 문단을 그 스타일 모양 그대로로(SPEC-003) */
  style: z.string().optional(),
});

/**
 * insert_table(SPEC-003, #38): 기준 블록이 든 본문 문단 앞·뒤에 새 문단 하나를 넣고 rows×cols 표를 담는다("문단 넣기 + 표 넣기" 한 편집).
 * 크기·cells 검사는 create-document.ts assertTableSpec(서버도 보내기 전에 같은 것으로 거부한다)
 */
export const insertTableOperationSchema = z.object({
  kind: z.literal('insert_table'),
  /** 기준 블록. 표·누름틀이면 그것이 든 문단이 기준이다(표 칸 안에는 넣지 않는다) */
  reference: anchoredBlockSchema,
  where: z.enum(['before', 'after']),
  rows: z.number().int(),
  cols: z.number().int(),
  /** 행 × 열 글자. 칸 글자의 줄바꿈은 칸 안 문단 */
  cells: z.array(z.array(z.string())).optional(),
  /** 첫 행을 머리글로(제목 셀·제목 줄 반복·굵은 글자) */
  header: z.boolean().optional(),
});

export const deleteBlocksOperationSchema = z.object({
  kind: z.literal('delete_blocks'),
  targets: z.array(anchoredBlockSchema).min(1),
});

/** set_style(SPEC-003): 문단 블록들의 문단 스타일을 바꾼다. 스타일 이름은 한글·영문 이름 */
export const setStyleOperationSchema = z.object({
  kind: z.literal('set_style'),
  targets: z.array(anchoredBlockSchema).min(1),
  style: z.string(),
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
  insertTableOperationSchema,
  deleteBlocksOperationSchema,
  moveBlocksOperationSchema,
  setStyleOperationSchema,
]);
export type EditOperation = z.infer<typeof editOperationSchema>;
export type ReplaceTextOperation = z.infer<typeof replaceTextOperationSchema>;
export type InsertParagraphOperation = z.infer<typeof insertParagraphOperationSchema>;
export type InsertTableOperation = z.infer<typeof insertTableOperationSchema>;
export type DeleteBlocksOperation = z.infer<typeof deleteBlocksOperationSchema>;
export type MoveBlocksOperation = z.infer<typeof moveBlocksOperationSchema>;
export type SetStyleOperation = z.infer<typeof setStyleOperationSchema>;

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

function assertSomethingToChange(target: AnchoredTarget, start: number, end: number, text: string): void {
  if (start === end && text.length === 0) {
    throw new Error(`${targetLabel(target)}: 바꿀 것이 없습니다(빈 범위에 빈 글자). 지우려면 범위를, 넣으려면 글자를 주세요.`);
  }
}

/** 편집 전 블록으로 검사를 마친 바꿀 자리 하나. 적용은 문서만 본다(앞 자리를 바꿔 블록 글자가 달라져도 그대로 쓴다) */
interface ReplaceSpot {
  target: AnchoredTarget;
  block: Block;
  /** 겹침을 보는 묶음: 같은 블록(표는 같은 칸) */
  group: string;
  start: number;
  end: number;
  apply: (doc: HwpDocument, text: string) => void;
}

/** 블록 종류마다 정하는 범위와 적용 */
type SpotRange = Pick<ReplaceSpot, 'start' | 'end' | 'apply'>;

function tableSpot(block: TableBlock, target: AnchoredTarget): SpotRange & { cellIndex: number } {
  if (target.cell === undefined) throw new Error(`${target.id}: 표 블록은 cell 로 바꿀 칸을 고르세요.`);
  const { row, col } = target.cell;
  const cellIndex = block.cells.findIndex((cell) => cell.row === row && cell.col === col);
  if (cellIndex === -1) {
    throw new Error(
      `${target.id}: 표에 없는 칸입니다(row ${row}, col ${col}). 이 표는 ${block.rowCount}행 ${block.colCount}열이고, 합친 칸은 왼쪽 위 칸 좌표로 고릅니다(read_blocks 의 cells).`,
    );
  }
  const { start, end } = spanIn(target, block.cells[cellIndex]?.text ?? '', EDIT_SPAN);
  const address = { section: block.section, paragraph: block.paragraph, controlIndex: block.controlIndex, cellIndex };
  return { cellIndex, start, end, apply: (doc, text) => replaceCellText(doc, address, text, start, end) };
}

function fieldSpot(doc: HwpDocument, block: FieldBlock, target: AnchoredTarget): SpotRange {
  if (target.cell !== undefined) throw new Error(`${target.id}: 표 블록이 아니라 cell 을 줄 수 없습니다.`);
  // 같은 문단의 몇 번째 누름틀인지는 서버가 보낸 위치에 있다(블록 추출이 getFieldList 순서를 따른다).
  // 이름은 겹칠 수 있어 fieldId 로 고른다(ADR 002)
  const ordinal = fieldOrdinal(target.anchor) ?? 0;
  const field = listFields(doc).filter(
    (candidate) => candidate.location.sectionIndex === block.section && candidate.location.paraIndex === block.paragraph,
  )[ordinal];
  if (field === undefined) throw new Error(`${target.id}: 뷰어 문서에서 이 누름틀을 찾지 못했습니다. get_outline 을 다시 부르세요.`);
  const path = field.location.path ?? [];
  if (path.length > 1 || !path.every(isCellStep)) {
    throw new Error(`${target.id}: 표 안 표나 글상자에 든 누름틀은 아직 바꿀 수 없습니다.`);
  }
  const { start, end } = spanIn(target, block.value, EDIT_SPAN);
  return { start, end, apply: (doc, text) => replaceFieldText(doc, field.fieldId, text, start, end) };
}

/** 대상 하나를 편집 전 블록으로 검사해 바꿀 자리로 만든다. 틀리면 던진다(문서는 아직 그대로) */
function replaceSpot(doc: HwpDocument, blocks: Block[], target: AnchoredTarget, text: string): ReplaceSpot {
  const block = blockAt(blocks, target);
  const blockKey = `${target.anchor.section}:${target.anchor.paragraph}:${target.anchor.part}`;
  const spot = (() => {
    switch (block.kind) {
      case 'paragraph': {
        if (target.cell !== undefined) throw new Error(`${target.id}: 표 블록이 아니라 cell 을 줄 수 없습니다.`);
        const { start, end } = spanIn(target, block.text, EDIT_SPAN);
        return {
          group: blockKey,
          start,
          end,
          apply: (doc: HwpDocument, text: string) => replaceParagraphText(doc, block.section, block.paragraph, text, start, end),
        };
      }
      case 'table': {
        const { cellIndex, ...rest } = tableSpot(block, target);
        return { group: `${blockKey}#${cellIndex}`, ...rest };
      }
      case 'field':
        return { group: blockKey, ...fieldSpot(doc, block, target) };
    }
  })();
  assertSomethingToChange(target, spot.start, spot.end, text);
  return { target, block, ...spot };
}

/** 같은 블록(칸) 안 자리가 겹치면 던진다. 같은 위치에 넣기 둘(빈 범위)도 어느 것이 앞인지 정할 수 없어 겹침이다 */
function assertNoOverlap(spots: ReplaceSpot[]): void {
  const ordered = [...spots].sort((a, b) => a.group.localeCompare(b.group) || a.start - b.start || a.end - b.end);
  ordered.forEach((spot, i) => {
    const previous = ordered[i - 1];
    if (previous === undefined || previous.group !== spot.group) return;
    if (spot.start < previous.end || spot.start === previous.start) {
      throw new Error(`바꿀 자리가 겹칩니다: ${targetLabel(spot.target)} ${spot.start}~${spot.end}`);
    }
  });
}

/** 적용 순서: 누름틀 값은 문단 글자 안에 있어 값을 바꾸면 문단 위치가 밀리므로 문단·칸 글자를 먼저, 묶음 안에서는 뒤 자리부터 */
const applyOrder = (a: ReplaceSpot, b: ReplaceSpot) => Number(a.block.kind === 'field') - Number(b.block.kind === 'field') || b.start - a.start;

/**
 * replace_text: 자리마다 범위의 글자를 바꾼다. 글자 모양은 자리마다 바뀌는 자리 첫 글자를 따른다(edits.ts).
 * 모든 자리를 편집 전 블록으로 먼저 검사(범위·칸·겹침)하고, 같은 블록 안은 뒤 자리부터 바꿔 앞 위치가 밀리지 않게 한다(SPEC-005)
 */
function replaceText(doc: HwpDocument, blocks: Block[], { targets, text }: ReplaceTextOperation): EditApplied {
  // 줄바꿈 거부는 edits.ts 가 편집 전에 한다(글자는 모든 자리에 같아 첫 자리에서 거부된다)
  assertTargetCount(targets.length);
  const spots = targets.map((target) => replaceSpot(doc, blocks, target, text));
  assertNoOverlap(spots);
  for (const spot of [...spots].sort(applyOrder)) spot.apply(doc, text);
  const paragraphs = new Map(spots.map(({ block: { section, paragraph } }) => [positionKey({ section, paragraph }), { section, paragraph }]));
  return { paragraphs: [...paragraphs.values()] };
}

/**
 * insert_paragraph: 기준 블록이 든 문단 앞·뒤에 새 문단을 넣는다. 서식은 기준 문단을 따른다(edits.ts insertParagraphNear).
 * style 을 주면 새 문단을 그 스타일 모양 그대로로 덮는다(문단·글자 모두 — 기준 문단의 직접 서식을 물려받지 않는다, SPEC-003)
 */
function insertParagraph(doc: HwpDocument, blocks: Block[], { reference, where, text, style }: InsertParagraphOperation): EditApplied {
  // 표 칸 안 문단은 블록이 아니므로 기준은 언제나 본문 문단이다(표·누름틀 블록이면 그것을 품은 문단). 줄바꿈 거부는 edits.ts
  const { section, paragraph } = blockAt(blocks, reference);
  // 없는 스타일은 문서를 건드리기 전에 거부한다
  const styleEntry = style === undefined ? undefined : findStyle(doc, style);
  // 스타일로 덮을 문단은 기준 문단 모양을 맞추지 않는다(맞추며 새 글자 모양 id 가 생겨 쓰이지 않고 남는다)
  const at = insertParagraphNear(doc, section, paragraph, where, text, { matchReference: styleEntry === undefined });
  const position = { section, paragraph: at };
  if (styleEntry !== undefined) resetToStyle(doc, section, at, styleEntry);
  return { paragraphs: [position], changes: { ...noParagraphChanges(), inserted: [{ ...position, part: TEXT_PART }] } };
}

/**
 * insert_table: 기준 블록이 든 문단 앞·뒤에 바탕글 문단을 넣고 표를 담는다(create-document.ts insertTableParagraph — ADR 003).
 * 넣은 문단은 표 문단이라 changes.inserted 의 part 를 표 꼬리표로 실어, 서버가 새 id 를 표 블록에 주게 한다
 */
function insertTable(doc: HwpDocument, blocks: Block[], { reference, where, rows, cols, cells, header }: InsertTableOperation): EditApplied {
  const { section, paragraph } = blockAt(blocks, reference);
  const table = insertTableParagraph(doc, section, paragraph, where, { rows, cols, cells, header });
  const position = { section, paragraph: table.paragraph };
  return { paragraphs: [position], changes: { ...noParagraphChanges(), inserted: [{ ...position, part: tablePart(table.controlIndex) }] } };
}

/** set_style: 문단 블록마다 스타일을 건다(styles.ts applyParagraphStyle). 번호가 바뀐 다른 문단은 공용 경로가 바뀐 블록에 더한다 */
function setStyle(doc: HwpDocument, blocks: Block[], { targets, style }: SetStyleOperation): EditApplied {
  // 표·누름틀 거부(assertStylable)는 서버가 보내기 전에 한다. 뷰어는 지금 블록 종류만 본다
  const styleEntry = findStyle(doc, style);
  const paragraphs = targets.map((target) => {
    const block = blockAt(blocks, target);
    // 서버 id 표와 뷰어 블록 종류가 다르면(있으면 안 된다) 문단이 아닌 블록에 걸지 않는다
    if (block.kind !== 'paragraph') throw new Error(`${target.id}: 뷰어 문서에서 이 블록은 문단이 아닙니다. get_outline 을 다시 부르세요.`);
    return { section: block.section, paragraph: block.paragraph };
  });
  for (const { section, paragraph } of paragraphs) applyParagraphStyle(doc, section, paragraph, styleEntry);
  return { paragraphs };
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
  // 거꾸로: 범위 안 뷰어 블록이 모두 서버가 아는 블록이어야 한다(아니면 서버 id 표에 없는 블록을 조용히 같이 옮긴다)
  const known = new Set(moving.map(({ anchor }) => `${anchor.paragraph}:${anchor.part}`));
  const viewerOnly = anchorsOf(blocks).filter(
    (anchor) => anchor.section === section && start <= anchor.paragraph && anchor.paragraph < end && !known.has(`${anchor.paragraph}:${anchor.part}`),
  );
  if (viewerOnly.length > 0) {
    const where = viewerOnly.map(({ paragraph, part }) => `문단 ${paragraph} ${part}`).join(', ');
    throw new Error(`옮길 범위의 블록이 서버와 뷰어에서 다릅니다(뷰어에만 있는 블록: ${where}). open_document 로 문서를 다시 열어 주세요.`);
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
    case 'insert_table':
      return insertTable(doc, blocks, operation);
    case 'delete_blocks':
      return { paragraphs: [], changes: deleteBlocks(doc, blocks, operation.targets) };
    case 'move_blocks':
      return moveBlocks(doc, blocks, operation);
    case 'set_style':
      return setStyle(doc, blocks, operation);
    default: {
      // 편집 종류를 더하고 여기 처리를 빠뜨리면 컴파일 오류가 난다
      const unhandled: never = operation;
      throw new Error(`처리하지 않는 편집입니다: ${JSON.stringify(unhandled)}`);
    }
  }
}
