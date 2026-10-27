// 사람 편집(SPEC-006 "편집은 서버를 거친다"): 뷰어가 보낸 편집(블록 위치 대상)을 id 표로 블록 id 로 바꿔
// Claude 편집과 같은 직렬 큐·편집 기록(session.edit)으로 처리한다. 거부 규칙도 Claude 편집과 같다(assertDeletable·planMove).
// 편집 기록 이름에 출처(사용자 화면 편집)를 붙이고, 다음 도구 결과에 알림(notices)으로 한 번 알린다(session).
import type { BlockAnchor, BlockIdTable } from '../core/block-ids.ts';
import { assertDeletable } from '../core/delete-blocks.ts';
import type { EditOperation } from '../core/edit-operations.ts';
import { targetLabel } from '../core/text-targets.ts';
import type { UserEdit, UserRequestMessage, UserResult } from '../shared/protocol.ts';
import { NOTHING_TO_UNDO } from './edit-tools.ts';
import { planMove } from './move-plan.ts';
import type { DocumentSession } from './session.ts';

export const STALE_USER_EDIT = '그사이 문서가 바뀌어 적용하지 못했습니다. 다시 고쳐 주세요.';
export const UNKNOWN_VIEWER_BLOCK = '뷰어 화면의 블록을 찾지 못했습니다. 뷰어 탭을 새로고침하세요.';
/** 편집 기록 이름 뒤에 붙는 출처. Claude 의 undo 결과에서 사람 편집을 가린다 */
export const USER_EDIT_MARK = ' (사용자 화면 편집)';

function idAt(ids: BlockIdTable, anchor: BlockAnchor): string {
  const id = ids.idAt(anchor);
  if (id === undefined) throw new Error(UNKNOWN_VIEWER_BLOCK);
  return id;
}

/** 사람 편집 → 편집 이름·편집·알림 한 마디. 거부되면(Claude 편집과 같은 규칙) 던진다 */
function prepareUserEdit(ids: BlockIdTable, edit: UserEdit): { label: string; operation: EditOperation; notice: string } {
  switch (edit.kind) {
    case 'replace_text': {
      const { anchor, ...range } = edit.target;
      const target = { id: idAt(ids, anchor), ...range };
      return {
        label: `replace_text ${targetLabel(target)}`,
        operation: { kind: 'replace_text', targets: [{ ...target, anchor }], text: edit.text },
        notice: `${target.id} 글자`,
      };
    }
    case 'delete_blocks': {
      const targets = edit.targets.map((anchor) => ({ id: idAt(ids, anchor), anchor }));
      assertDeletable(targets);
      const names = targets.map(({ id }) => id);
      return { label: `delete_blocks ${names.join(', ')}`, operation: { kind: 'delete_blocks', targets }, notice: `${names.join('·')} 지움` };
    }
    case 'move_blocks': {
      const chosen = edit.blocks.map((anchor) => idAt(ids, anchor));
      const { section, start, end, before, blocks } = planMove(ids, chosen, idAt(ids, edit.reference), edit.where);
      return {
        label: `move_blocks ${chosen.join(', ')}`,
        operation: { kind: 'move_blocks', section, start, end, before, blocks },
        notice: `${chosen.join('·')} 옮김`,
      };
    }
  }
}

/**
 * 사람 편집 하나를 편집 공용 경로로 한다. depth 는 뷰어가 편집을 만들 때의 편집 순번 — 줄 차례가 왔을 때 서버 순번과 다르면
 * (그사이 Claude 편집·되돌리기가 먼저 처리됨) 블록 위치가 어긋났을 수 있어 뷰어에 보내지 않고 거부한다
 */
export async function applyUserEdit(session: DocumentSession, edit: UserEdit, depth: number): Promise<void> {
  await session.edit((document) => {
    if (document.edits.depth !== depth) throw new Error(STALE_USER_EDIT);
    const { label, operation, notice } = prepareUserEdit(document.ids, edit);
    return { label: `${label}${USER_EDIT_MARK}`, operation, notice };
  });
}

/** ⌘Z: 공용 되돌리기 줄에서 마지막 편집 하나(사람·Claude 상관없이). 없으면 Claude undo 와 같은 문구로 거부한다 */
export async function undoFromViewer(session: DocumentSession): Promise<UserResult<'user_undo'>> {
  const undone = await session.undo(1, 'user');
  if (undone.length === 0) throw new Error(NOTHING_TO_UNDO);
  return { undone };
}

/** 뷰어 요청 처리(bridge.serveUserRequests 에 넘긴다) */
export async function handleUserRequest(session: DocumentSession, request: UserRequestMessage): Promise<unknown> {
  switch (request.method) {
    case 'user_edit':
      await applyUserEdit(session, request.params.edit, request.params.depth);
      return {};
    case 'user_undo':
      return undoFromViewer(session);
  }
}
