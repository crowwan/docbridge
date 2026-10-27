// 편집 도구(SPEC-002): 대상 id 를 id 표 위치로 바꿔 편집 공용 경로(session.edit)로 뷰어에 보내고, 바뀐 블록에 id 를 붙여 돌려준다.
// 새 편집 도구(#20 insert_paragraph·delete_blocks, #21 move_blocks)는 core/edit-operations.ts 에 편집 종류를 더하고
// 여기서 session.edit(이름, 문서 → 편집, id 표 옮기기) 를 부른다.
import { UNDO_LIMIT } from '../core/edit-history.ts';
import { targetLabel } from '../core/text-targets.ts';
import type { TextTarget } from '../shared/protocol.ts';
import { anchoredTarget } from './highlight-tools.ts';
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
  return {
    changed: changed.flatMap((edited) => changedItem(edited, target.cell)),
    ...(unmarked.length === 0 ? {} : { warnings: unmarked.map(unmarkedMessage) }),
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
