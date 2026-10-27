// 편집 도구(SPEC-002): 대상 id 를 id 표 위치로 바꿔 편집 공용 경로(session.edit)로 뷰어에 보내고, 바뀐 블록에 id 를 붙여 돌려준다.
// 새 편집 도구(#21 move_blocks 등)는 core/edit-operations.ts 에 편집 종류를 더하고
// 여기서 session.edit(이름, 문서 → 편집) 를 부른다. 문단을 넣고 지운 만큼 id 표를 옮기는 일은 뷰어가 돌려준 결과로 session 이 한다.
import { assertDeletable } from '../core/delete-blocks.ts';
import { UNDO_LIMIT } from '../core/edit-history.ts';
import { targetLabel } from '../core/text-targets.ts';
import type { TextTarget } from '../shared/protocol.ts';
import { anchored, anchoredTarget } from './highlight-tools.ts';
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
  const { changed, unmarked } = await session.edit(`replace_text ${targetLabel(target)}`, (document) => ({
    kind: 'replace_text',
    target: anchoredTarget(document.ids, target),
    text,
  }));
  return editResult(changed, unmarked, target.cell);
}

function editResult(changed: EditedBlock[], unmarked: string[], cell?: TextTarget['cell']): EditResult {
  return {
    changed: changed.flatMap((edited) => changedItem(edited, cell)),
    ...(unmarked.length === 0 ? {} : { warnings: unmarked.map(unmarkedMessage) }),
  };
}

export interface InsertParagraphResult extends EditResult {
  /** 새 문단 블록 id */
  inserted: string;
}

/** 기준 블록(before 또는 after 하나) 앞·뒤에 새 문단을 넣는다. 서식은 기준 문단을 따른다 */
export async function insertParagraph(
  session: DocumentSession,
  { before, after, text }: { before?: string; after?: string; text: string },
): Promise<InsertParagraphResult> {
  if ((before === undefined) === (after === undefined)) throw new Error('before 와 after 중 하나만 주세요.');
  const where = before === undefined ? 'after' : 'before';
  const referenceId = before ?? after ?? '';
  const { changed, unmarked, inserted } = await session.edit(`insert_paragraph ${where} ${referenceId}`, (document) => {
    const { anchor } = anchoredTarget(document.ids, { id: referenceId });
    return { kind: 'insert_paragraph', reference: { id: referenceId, anchor }, where, text };
  });
  const [id] = inserted;
  if (id === undefined) throw new Error(`${referenceId}: 뷰어가 넣은 문단을 알려 주지 않아 새 id 를 붙이지 못했습니다.`);
  return { inserted: id, ...editResult(changed, unmarked) };
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
  const { deleted } = await session.edit(`delete_blocks ${unique.join(', ')}`, (document) => {
    const targets = anchored(document.ids, unique.map((id) => ({ id }))).map(({ id, anchor }) => ({ id, anchor }));
    assertDeletable(targets);
    return { kind: 'delete_blocks', targets };
  });
  return { deleted };
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
