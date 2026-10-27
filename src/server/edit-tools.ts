// 편집 도구(SPEC-002): 대상 id 를 id 표 위치로 바꿔 편집 공용 경로(session.edit)로 뷰어에 보내고, 바뀐 블록에 id 를 붙여 돌려준다.
// 새 편집 도구(#21 move_blocks 등)는 core/edit-operations.ts 에 편집 종류를 더하고
// 여기서 session.edit(이름, 문서 → 편집, id 표 옮기기) 를 부른다.
import type { BlockIdTable } from '../core/block-ids.ts';
import { UNDO_LIMIT } from '../core/edit-history.ts';
import { planDeletion, type AnchoredBlock, type DeletionPlan } from '../core/edit-operations.ts';
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
  let inserted: string | undefined;
  const { changed, unmarked } = await session.edit(
    `insert_paragraph ${where} ${referenceId}`,
    (document) => {
      const { anchor } = anchoredTarget(document.ids, { id: referenceId });
      return { kind: 'insert_paragraph', reference: { id: referenceId, anchor }, where, text };
    },
    (ids) => {
      // 뷰어와 같은 자리: 앞에 넣으면 기준 문단 자리, 뒤에 넣으면 그다음 자리(표·누름틀이면 그것이 든 문단 기준)
      const anchor = ids.anchor(referenceId);
      if (anchor === undefined) return;
      inserted = ids.paragraphInserted(anchor.section, where === 'before' ? anchor.paragraph : anchor.paragraph + 1);
    },
  );
  if (inserted === undefined) throw new Error(`${referenceId}: 넣은 문단에 id 를 붙이지 못했습니다.`);
  return { inserted, ...editResult(changed, unmarked) };
}

export interface DeleteBlocksResult {
  /** 지운 블록 id(같이 지워진 표·누름틀 포함, 문서 순서) */
  deleted: string[];
}

/** 계획대로 지운 뒤 id 표: 표만 지운 자리는 그 표 id 를, 문단째 지운 자리는 그 문단 id 들을 없애고 위치를 당긴다 */
function applyDeletion(ids: BlockIdTable, plan: DeletionPlan): void {
  for (const table of [...plan.tables].reverse()) ids.tableDeleted(table.section, table.paragraph, table.controlIndex);
  for (const position of [...plan.paragraphs].reverse()) ids.paragraphDeleted(position.section, position.paragraph);
}

/** 지울 블록 id: 표만 지우는 표, 문단째 지우는 문단에 걸린 블록 모두. 문서 순서(문단 위치, 같은 문단 안은 id 순) */
function deletedIds(ids: BlockIdTable, plan: DeletionPlan): string[] {
  const whole = plan.paragraphs.flatMap(({ section, paragraph }) => ids.anchorsAt(section, paragraph));
  const tables = plan.tables.flatMap(({ section, paragraph, controlIndex }) =>
    ids.anchorsAt(section, paragraph).filter(({ anchor }) => anchor.part === `table:${controlIndex}`),
  );
  const idNumber = (id: string) => Number(id.slice(1));
  return [...whole, ...tables]
    .sort((a, b) => a.anchor.section - b.anchor.section || a.anchor.paragraph - b.anchor.paragraph || idNumber(a.id) - idNumber(b.id))
    .map(({ id }) => id);
}

/**
 * 블록(문단·표)을 지운다. 여러 id 도 편집 하나(undo 한 번). 누름틀 블록·구역 첫 문단은 뷰어에 보내기 전에 거부한다.
 * 지우기 계획은 서버(id 표 위치)와 뷰어(블록 위치)가 같은 함수(planDeletion)로 계산한다
 */
export async function deleteBlocks(session: DocumentSession, ids: string[]): Promise<DeleteBlocksResult> {
  const unique = [...new Set(ids)];
  let plan: DeletionPlan | undefined;
  let deleted: string[] = [];
  await session.edit(
    `delete_blocks ${unique.join(', ')}`,
    (document) => {
      const targets: AnchoredBlock[] = anchored(document.ids, unique.map((id) => ({ id }))).map(({ id, anchor }) => ({ id, anchor }));
      plan = planDeletion(targets, (section, paragraph) => document.ids.anchorsAt(section, paragraph).map(({ anchor }) => anchor));
      deleted = deletedIds(document.ids, plan);
      return { kind: 'delete_blocks', targets };
    },
    (table) => {
      if (plan !== undefined) applyDeletion(table, plan);
    },
  );
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
