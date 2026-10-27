// 편집 도구(SPEC-002): 대상 id 를 id 표 위치로 바꿔 편집 공용 경로(session.edit)로 뷰어에 보내고, 바뀐 블록에 id 를 붙여 돌려준다.
// 새 편집 도구(#21 move_blocks 등)는 core/edit-operations.ts 에 편집 종류를 더하고
// 여기서 session.edit(문서 → { 이름, 편집 }) 를 부른다. 문단을 넣고 지운 만큼 id 표를 옮기는 일은 뷰어가 돌려준 결과로 session 이 한다.
import { assertTableSpec, type TableSpec } from '../core/create-document.ts';
import { assertDeletable } from '../core/delete-blocks.ts';
import { UNDO_LIMIT } from '../core/edit-history.ts';
import { targetLabel } from '../core/text-targets.ts';
import type { TextTarget } from '../shared/protocol.ts';
import { anchored, anchoredTarget } from './highlight-tools.ts';
import { planMove, type MovePlan } from './move-plan.ts';
import { labeledBlocks } from './read-tools.ts';
import { outlineItem, preview } from './reading.ts';
import type { DocumentSession, EditedBlock } from './session.ts';

export const NOTHING_TO_UNDO = '되돌릴 편집이 없습니다.';

export interface ChangedItem {
  id: string;
  /** 표 칸을 바꿨으면 그 칸 */
  cell?: { row: number; col: number };
  /** 바뀐 뒤 블록(표 칸이면 그 칸) 앞 40자 */
  text: string;
}

export interface EditResult {
  /** 바뀐 블록. 대상 블록과 같은 문단에 걸린 블록(문단 글자·표·누름틀)을 모두 담는다 */
  changed: ChangedItem[];
  /** 바뀌었지만 뷰어에 표시하지 못한 블록 안내 */
  warnings?: string[];
}

export const unmarkedMessage = (id: string) => `${id}: 화면에 표시할 자리가 없어(빈 문단 등) 바뀐 블록 표시를 하지 못했습니다.`;

/** 바뀐 블록 → 결과 항목. 칸을 고친 편집이면 표는 그 칸 글자를 앞 40자로 보인다 */
function changedItem({ id, block }: EditedBlock, cell: TextTarget['cell']): ChangedItem[] {
  if (id === undefined) return [];
  if (block.kind === 'table' && cell !== undefined) {
    const text = block.cells.find(({ row, col }) => row === cell.row && col === cell.col)?.text ?? '';
    return [{ id, cell, text: preview(text) }];
  }
  return [{ id, text: outlineItem({ id, block }).text }];
}

export async function replaceText(session: DocumentSession, target: TextTarget, text: string): Promise<EditResult> {
  const { changed, unmarked } = await session.edit((document) => ({
    label: `replace_text ${targetLabel(target)}`,
    operation: { kind: 'replace_text', target: anchoredTarget(document.ids, target), text },
  }));
  return editResult(changed, unmarked, target.cell);
}

function editResult(changed: EditedBlock[], unmarked: string[], cell?: TextTarget['cell']): EditResult {
  return {
    changed: changed.flatMap((edited) => changedItem(edited, cell)),
    ...(unmarked.length === 0 ? {} : { warnings: unmarked.map(unmarkedMessage) }),
  };
}

/** 바뀐 블록 결과 항목에 자동 번호를 붙인 것(insert_paragraph·insert_table·move_blocks·set_style). 번호는 바뀐 뒤 번호 */
export type NumberedItem = ChangedItem & { number?: string };

/** 바뀐 블록 → 번호를 붙인 결과 항목(get_outline 항목과 같은 number·text). id 가 없으면 빈 배열 */
export function numberedItem({ id, block }: EditedBlock): NumberedItem[] {
  if (id === undefined) return [];
  const { number, text } = outlineItem({ id, block });
  return [{ id, ...(number === undefined ? {} : { number }), text }];
}

export interface InsertParagraphResult {
  /** 새 문단 블록 id */
  inserted: string;
  /** 새 문단과 번호가 다시 매겨진 문단(number 는 넣은 뒤 자동 번호) */
  changed: NumberedItem[];
  warnings?: string[];
}

export const WHERE_REQUIRED = 'before 와 after 중 하나만 주세요.';

/** 기준 블록 입력(before 또는 after 하나) → 기준 id 와 방향. 둘 다 주거나 하나도 안 주면 던진다(insert_paragraph·move_blocks 공용) */
export function referenceOf({ before, after }: { before?: string; after?: string }): { referenceId: string; where: 'before' | 'after' } {
  if (before !== undefined && after === undefined) return { referenceId: before, where: 'before' };
  if (after !== undefined && before === undefined) return { referenceId: after, where: 'after' };
  throw new Error(WHERE_REQUIRED);
}

/** 기준 블록(before 또는 after 하나) 앞·뒤에 새 문단을 넣는다. 서식은 기준 문단을 따르고, style 을 주면 그 스타일 모양 그대로다(SPEC-003) */
export async function insertParagraph(
  session: DocumentSession,
  { before, after, text, style }: { before?: string; after?: string; text: string; style?: string },
): Promise<InsertParagraphResult> {
  const { referenceId, where } = referenceOf({ before, after });
  const { changed, unmarked, inserted } = await session.edit((document) => {
    const { anchor } = anchoredTarget(document.ids, { id: referenceId });
    return {
      label: `insert_paragraph ${where} ${referenceId}${style === undefined ? '' : ` (${style})`}`,
      operation: { kind: 'insert_paragraph', reference: { id: referenceId, anchor }, where, text, ...(style === undefined ? {} : { style }) },
    };
  });
  const [id] = inserted;
  if (id === undefined) throw new Error(`${referenceId}: 뷰어가 넣은 문단을 알려 주지 않아 새 id 를 붙이지 못했습니다.`);
  return {
    inserted: id,
    changed: changed.flatMap(numberedItem),
    ...(unmarked.length === 0 ? {} : { warnings: unmarked.map(unmarkedMessage) }),
  };
}

export interface InsertTableResult {
  /** 새 표 블록 id */
  inserted: string;
  /** 칸 수(rows × cols) */
  cells: number;
  /** 새 표와 번호가 다시 매겨진 문단(insert_paragraph 결과와 같은 모양, number 는 넣은 뒤 자동 번호) */
  changed: NumberedItem[];
  warnings?: string[];
}

/**
 * insert_table(SPEC-003): 기준 블록(before 또는 after 하나) 앞·뒤에 바탕글 문단을 넣고 rows×cols 표를 담는다. 편집 하나(undo 한 번).
 * 크기·cells 는 뷰어에 보내기 전에 거부하고, 새 id 는 뷰어가 돌려준 넣은 문단의 표에 session 이 준다
 */
export async function insertTable(
  session: DocumentSession,
  { before, after, ...spec }: { before?: string; after?: string } & TableSpec,
): Promise<InsertTableResult> {
  const { referenceId, where } = referenceOf({ before, after });
  // 크기는 문서·id 와 상관없이 먼저(스펙 문구가 "없는 블록 id" 에 가려지지 않게)
  assertTableSpec(spec);
  const { changed, unmarked, inserted } = await session.edit((document) => {
    const { anchor } = anchoredTarget(document.ids, { id: referenceId });
    return {
      label: `insert_table ${where} ${referenceId}`,
      operation: { kind: 'insert_table', reference: { id: referenceId, anchor }, where, ...spec },
    };
  });
  const [id] = inserted;
  if (id === undefined) throw new Error(`${referenceId}: 뷰어가 넣은 표를 알려 주지 않아 새 id 를 붙이지 못했습니다.`);
  return {
    inserted: id,
    cells: spec.rows * spec.cols,
    changed: changed.flatMap(numberedItem),
    ...(unmarked.length === 0 ? {} : { warnings: unmarked.map(unmarkedMessage) }),
  };
}

export interface DeleteBlocksResult {
  /** 지운 블록 id(같이 지워진 표·누름틀 포함, 문서 순서) */
  deleted: string[];
}

/**
 * 블록(문단·표)을 지운다. 여러 id 도 편집 하나(undo 한 번). 누름틀 블록·구역 첫 문단은 뷰어에 보내기 전에 거부한다.
 * 무엇을 지울지(문단째·표만)는 뷰어가 지금 문서로 정하고, 결과의 지운 id 는 뷰어가 실제로 지운 문단·표에서 나온다(session.edit)
 */
export async function deleteBlocks(session: DocumentSession, ids: string[]): Promise<DeleteBlocksResult> {
  const unique = [...new Set(ids)];
  const { deleted } = await session.edit((document) => {
    const targets = anchored(document.ids, unique.map((id) => ({ id }))).map(({ id, anchor }) => ({ id, anchor }));
    assertDeletable(targets);
    return { label: `delete_blocks ${unique.join(', ')}`, operation: { kind: 'delete_blocks', targets } };
  });
  return { deleted };
}


export interface MoveBlocksResult {
  /** 옮긴 블록 id(문서 순서). 고른 블록과 같은 문단에 걸린 블록도 담는다 */
  moved: string[];
  /** 옮긴 블록과 자동 번호가 바뀐 문단의 블록(문서 순서) */
  changed: NumberedItem[];
  /** 직접 입력한 번호가 있는 문단, 뷰어에 표시하지 못한 블록 */
  warnings?: string[];
}

// 글자로 친 번호: 1. 12) 가. 나) (1) (가) ① ㉠ ㉮ Ⅰ. — 숫자·한글·괄호·동그라미 번호는 뒤에 공백이나 글 끝이 와야 한다(①번 항목, (사)한국… 같은 문장은 아니다)(2026. 11. 같은 날짜는 4자리라 아니다)
const TYPED_NUMBER =
  /^\s*(?:(?:\d{1,2}|[가나다라마바사아자차카타파하])[.)](?=\s|$)|[(（](?:\d{1,2}|[가나다라마바사아자차카타파하])[)）](?=\s|$)|[\u2460-\u2473\u3260-\u327B](?=\s|$)|[\u2160-\u216B\u2170-\u217B][.)](?=\s|$))/u;

/** 문단 글자 맨 앞에 직접 입력한 번호가 있는지(SPEC-002 "직접 입력한 번호") */
export const hasTypedNumber = (text: string) => TYPED_NUMBER.test(text);

export const typedNumberMessage = (ids: string[]) =>
  `직접 입력한 번호가 있는 문단: ${ids.join(', ')}. 번호를 고치려면 replace_text 를 쓰세요.`;

/** 편집 이름: 고른 블록을 문서 순서로(셋 이상이면 첫~끝) */
const moveLabel = (ids: string[]) => `move_blocks ${ids.length <= 2 ? ids.join(', ') : `${ids[0]}~${ids.at(-1)}`}`;

/**
 * move_blocks: 이어진 블록을 기준 블록 앞/뒤로 서식째 옮긴다. 거부 판정과 범위는 planMove(id 표), 옮기기는 뷰어,
 * id 표는 뷰어가 돌려준 실제로 옮긴 범위(changes.moved)로 session 이 옮긴다
 */
export async function moveBlocks(
  session: DocumentSession,
  { ids, before, after }: { ids: string[]; before?: string; after?: string },
): Promise<MoveBlocksResult> {
  const { referenceId: reference, where } = referenceOf({ before, after });
  let plan: MovePlan | undefined;
  const chosen = new Set(ids);
  const { changed, unmarked } = await session.edit((document) => {
    plan = planMove(document.ids, ids, reference, where);
    const { section, start, end, before, blocks } = plan;
    return {
      label: moveLabel(blocks.flatMap(({ id }) => (chosen.has(id) ? [id] : []))),
      operation: { kind: 'move_blocks', section, start, end, before, blocks },
    };
  });
  // 옮긴 블록 = 옮긴 범위에 든 블록(문서 순서. id 는 그대로라 계획 때 id 와 같고, 뷰어가 범위를 양방향으로 맞춰 본다)
  const moved = plan?.blocks.map(({ id }) => id) ?? [];
  const movedIds = new Set(moved);
  // 직접 입력한 번호: 옮긴 문단과 사이에서 순서가 바뀐 문단을 본다. 사이 문단은 바뀐 블록이 아니라 글자를 뷰어에서 다시 받는다
  const reordered = new Set([...movedIds, ...(plan?.shifted ?? [])]);
  const typed = (await labeledBlocks(session)).filter(
    ({ id, block }) => reordered.has(id) && block.kind === 'paragraph' && hasTypedNumber(block.text),
  );
  const warnings = [...(typed.length === 0 ? [] : [typedNumberMessage(typed.map(({ id }) => id))]), ...unmarked.map(unmarkedMessage)];
  return {
    moved,
    changed: changed.flatMap(numberedItem),
    ...(warnings.length === 0 ? {} : { warnings }),
  };
}

export interface UndoResult {
  /** 되돌린 편집 수 */
  undone: number;
  /** 되돌린 편집(최근 것부터) */
  edits: string[];
  /** 달라는 만큼 되돌리지 못했을 때 안내 */
  warnings?: string[];
}

export async function undo(session: DocumentSession, steps: number): Promise<UndoResult> {
  const edits = await session.undo(steps);
  if (edits.length === 0) throw new Error(NOTHING_TO_UNDO);
  const short = edits.length < steps;
  return {
    undone: edits.length,
    edits,
    ...(short ? { warnings: [`되돌릴 수 있는 편집이 ${edits.length}개뿐이라(최대 ${UNDO_LIMIT}단계) ${edits.length}개를 되돌렸습니다.`] } : {}),
  };
}
