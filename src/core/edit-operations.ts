// 편집 종류(SPEC-002 편집 도구)와 rhwp 문서에 적용하기. 뷰어와 테스트 뷰어가 같이 쓴다(document-editor.ts 가 부른다).
// 편집은 kind 로 가르는 판별 유니언이다. 새 편집(#21 옮기기 등)은
// 1) editOperationSchema 에 스키마 하나 2) applyEdit 의 switch 에 case 하나를 더한다(case 를 빠뜨리면 컴파일 오류).
// 대상 블록은 서버가 붙인 위치(anchor)로 지금 블록 목록에서 찾고, 범위·칸 검사는 블록 글자를 가진 여기서 한다.
import type { HwpDocument } from '@rhwp/core';
import { z } from 'zod';
import { anchorsOf, blockIndexByAnchor, fieldOrdinal, tableControlIndex, type BlockAnchor } from './block-ids.ts';
import { anchoredTargetSchema, type AnchoredTarget, type Block, type FieldBlock, type TableBlock } from './block-schema.ts';
import { parseJson } from './json.ts';
import { spanIn, targetLabel } from './text-targets.ts';
import { insertParagraphNear, listFields, replaceCellText, replaceFieldText, replaceParagraphText } from './edits.ts';

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

/** 뷰어가 적용하는 편집. kind 마다 입력이 다르다 */
export const editOperationSchema = z.discriminatedUnion('kind', [
  replaceTextOperationSchema,
  insertParagraphOperationSchema,
  deleteBlocksOperationSchema,
]);
export type EditOperation = z.infer<typeof editOperationSchema>;
export type ReplaceTextOperation = z.infer<typeof replaceTextOperationSchema>;
export type InsertParagraphOperation = z.infer<typeof insertParagraphOperationSchema>;
export type DeleteBlocksOperation = z.infer<typeof deleteBlocksOperationSchema>;

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
  /** 편집 전 문단 위치 → 편집 뒤 위치(지운 문단은 undefined). 문단을 넣거나 지우는 편집만 준다 */
  relocate?: (position: ParagraphPosition) => ParagraphPosition | undefined;
  /** 새로 넣은 문단: 비어 있어도 블록으로 남긴다 */
  inserted?: ParagraphPosition[];
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

/** 넣은 문단 at 부터 뒤 문단이 하나씩 밀린다 */
const shiftedFrom =
  (section: number, at: number) =>
  (position: ParagraphPosition): ParagraphPosition =>
    position.section === section && position.paragraph >= at ? { section, paragraph: position.paragraph + 1 } : position;

/** insert_paragraph: 기준 블록이 든 문단 앞·뒤에 새 문단을 넣는다. 서식은 기준 문단을 따른다(edits.ts insertParagraphNear) */
function insertParagraph(doc: HwpDocument, blocks: Block[], { reference, where, text }: InsertParagraphOperation): EditApplied {
  // 표 칸 안 문단은 블록이 아니므로 기준은 언제나 본문 문단이다(표·누름틀 블록이면 그것을 품은 문단)
  const { section, paragraph } = blockAt(blocks, reference);
  if (/[\r\n]/.test(text)) {
    throw new Error('넣을 글자에 줄바꿈이 있습니다. 문단을 여럿 넣으려면 insert_paragraph 를 문단마다 부르세요.');
  }
  const at = insertParagraphNear(doc, section, paragraph, where, text);
  const position = { section, paragraph: at };
  return { paragraphs: [position], inserted: [position], relocate: shiftedFrom(section, at) };
}

/** 지우기 계획: 통째로 지울 문단과, 문단은 두고 지울 표 */
export interface DeletionPlan {
  paragraphs: ParagraphPosition[];
  tables: Array<ParagraphPosition & { controlIndex: number }>;
}

const FIRST_PARAGRAPH = 0;

/**
 * delete_blocks 대상 → 지우기 계획. 서버(id 표 위치)와 뷰어(블록 위치)가 같은 함수로 계산한다.
 * - 문단 블록은 문단째(든 표·누름틀도 같이) 지운다
 * - 표 블록은 그 문단에 다른 블록이 없으면 문단째(빈 줄이 남지 않게), 있으면 표만 지운다.
 *   글자 없는 문단의 누름틀은 표 안 누름틀이라 "다른 블록"으로 세지 않는다
 * - 누름틀 블록과 구역 첫 문단(구역·단 정의가 든다 — rhwp 는 지우면 정의도 같이 지운다) 지우기는 거부한다.
 *   첫 문단을 지우지 않으므로 구역이 비는 삭제(rhwp 가 거부)도 생기지 않는다
 */
export function planDeletion(
  targets: AnchoredBlock[],
  anchorsAt: (section: number, paragraph: number) => BlockAnchor[],
): DeletionPlan {
  const fields = targets.filter(({ anchor }) => fieldOrdinal(anchor) !== undefined).map(({ id }) => id);
  if (fields.length > 0) {
    throw new Error(
      `누름틀 블록은 지울 수 없습니다: ${fields.join(', ')}. 값을 비우려면 replace_text 를, 문단째 지우려면 그 문단 블록 id 를 주세요.`,
    );
  }
  const firsts = targets.filter(({ anchor }) => anchor.part === 'text' && anchor.paragraph === FIRST_PARAGRAPH).map(({ id }) => id);
  if (firsts.length > 0) {
    throw new Error(`구역 첫 문단은 지울 수 없습니다(구역·단 정의가 든 문단): ${firsts.join(', ')}. 글자를 지우려면 replace_text 를 쓰세요.`);
  }
  const byParagraph = new Map<string, { position: ParagraphPosition; parts: Set<string> }>();
  for (const { anchor } of targets) {
    const key = `${anchor.section}:${anchor.paragraph}`;
    const entry = byParagraph.get(key) ?? { position: { section: anchor.section, paragraph: anchor.paragraph }, parts: new Set<string>() };
    entry.parts.add(anchor.part);
    byParagraph.set(key, entry);
  }
  const plan: DeletionPlan = { paragraphs: [], tables: [] };
  for (const { position, parts } of byParagraph.values()) {
    const here = anchorsAt(position.section, position.paragraph);
    // 글자 없는 문단에 걸린 누름틀은 그 문단 표 안 누름틀로 본다(문단째 지우면 같이 지워진다)
    const hasText = here.some((anchor) => anchor.part === 'text');
    const others = here.filter((anchor) => !parts.has(anchor.part) && (hasText || fieldOrdinal(anchor) === undefined));
    const whole = parts.has('text') || (others.length === 0 && position.paragraph !== FIRST_PARAGRAPH);
    if (whole) {
      plan.paragraphs.push(position);
      continue;
    }
    for (const part of parts) {
      const controlIndex = tableControlIndex({ ...position, part });
      if (controlIndex !== undefined) plan.tables.push({ ...position, controlIndex });
    }
  }
  const order = (a: ParagraphPosition, b: ParagraphPosition) => a.section - b.section || a.paragraph - b.paragraph;
  plan.paragraphs.sort(order);
  plan.tables.sort((a, b) => order(a, b) || a.controlIndex - b.controlIndex);
  return plan;
}

const controlPositionsSchema = z.array(z.number());

/** delete_blocks: 계획대로 표(컨트롤 번호 큰 것부터)와 문단(뒤에서부터)을 지운다. 여러 블록도 편집 하나다 */
function deleteBlocks(doc: HwpDocument, blocks: Block[], { targets }: DeleteBlocksOperation): EditApplied {
  for (const target of targets) blockAt(blocks, target);
  const anchors = anchorsOf(blocks);
  const anchorsAt = (section: number, paragraph: number) =>
    anchors.filter((anchor) => anchor.section === section && anchor.paragraph === paragraph);
  const plan = planDeletion(targets, anchorsAt);
  const idAt = (position: ParagraphPosition, controlIndex?: number) =>
    targets.find(
      ({ anchor }) =>
        anchor.section === position.section &&
        anchor.paragraph === position.paragraph &&
        (controlIndex === undefined || tableControlIndex(anchor) === controlIndex),
    )?.id ?? `문단 ${position.paragraph}`;
  for (const position of plan.paragraphs) {
    const here = anchorsAt(position.section, position.paragraph);
    if (here.some((anchor) => anchor.part === 'text')) continue;
    // 글자 없이 표만 든 문단을 통째로 지울 때, 블록이 아닌 개체(그림 등)가 같이 있으면 그것까지 사라진다
    const controls = parseJson(controlPositionsSchema, doc.getControlTextPositions(position.section, position.paragraph));
    if (controls.length > here.filter((anchor) => tableControlIndex(anchor) !== undefined).length) {
      throw new Error(`${idAt(position)}: 표가 든 문단에 다른 개체(그림 등)가 있어 지울 수 없습니다.`);
    }
  }
  // 표만 지우면 그 표 안 누름틀도 사라지는데, 서버는 누름틀이 어느 표에 든 것인지 모른다(id 표가 어긋난다)
  const fields = listFields(doc);
  for (const table of plan.tables) {
    const inside = fields.some(
      ({ location }) =>
        location.sectionIndex === table.section &&
        location.paraIndex === table.paragraph &&
        location.path?.[0]?.controlIndex === table.controlIndex,
    );
    if (inside) {
      throw new Error(`${idAt(table, table.controlIndex)}: 누름틀이 든 표는 표만 지울 수 없습니다. 표가 든 문단의 다른 블록과 함께 지우세요.`);
    }
  }
  for (const table of [...plan.tables].reverse()) doc.deleteTableControl(table.section, table.paragraph, table.controlIndex);
  for (const position of [...plan.paragraphs].reverse()) doc.deleteParagraph(position.section, position.paragraph);
  const deleted = new Set(plan.paragraphs.map(({ section, paragraph }) => `${section}:${paragraph}`));
  const relocate = (position: ParagraphPosition): ParagraphPosition | undefined => {
    if (deleted.has(`${position.section}:${position.paragraph}`)) return undefined;
    const before = plan.paragraphs.filter((p) => p.section === position.section && p.paragraph < position.paragraph).length;
    return { section: position.section, paragraph: position.paragraph - before };
  };
  return { paragraphs: [], relocate };
}

/** 편집 하나를 문서에 적용한다. 던지면 문서가 반쯤 바뀌었을 수 있다 — 되돌리기는 부르는 쪽 스냅샷이 맡는다 */
export function applyEdit(doc: HwpDocument, blocks: Block[], operation: EditOperation): EditApplied {
  switch (operation.kind) {
    case 'replace_text':
      return replaceText(doc, blocks, operation);
    case 'insert_paragraph':
      return insertParagraph(doc, blocks, operation);
    case 'delete_blocks':
      return deleteBlocks(doc, blocks, operation);
    default: {
      // 편집 종류를 더하고 여기 처리를 빠뜨리면 컴파일 오류가 난다
      const unhandled: never = operation;
      throw new Error(`처리하지 않는 편집입니다: ${JSON.stringify(unhandled)}`);
    }
  }
}
