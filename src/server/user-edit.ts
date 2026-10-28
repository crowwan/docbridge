// 사람 편집(SPEC-006 "편집은 서버를 거친다"): 뷰어가 보낸 편집(블록 위치 대상)을 그 탭 문서(doc, SPEC-007)의 id 표로 블록 id 로 바꿔
// Claude 편집과 같은 그 문서의 직렬 큐·편집 기록(session.edit)으로 처리한다. 다른 문서의 편집·기록과는 섞이지 않는다. 거부 규칙도 Claude 편집과 같다(assertDeletable·planMove).
// 편집 기록 이름에 출처(사용자 화면 편집)를 붙이고, 다음 도구 결과에 알림(notices)으로 한 번 알린다(session).
import type { BlockAnchor, BlockIdTable } from '../core/block-ids.ts';
import { assertDeletable } from '../core/delete-blocks.ts';
import type { EditOperation } from '../core/edit-operations.ts';
import { targetLabel } from '../core/text-targets.ts';
import { USER_REQUEST_DEADLINE_MS, type UserEdit, type UserRequestMessage, type UserResult } from '../shared/protocol.ts';
import { EditRejection, USER_REJECTION_MESSAGES } from '../shared/rejections.ts';
import { NOTHING_TO_UNDO } from './edit-tools.ts';
import { exportPdfFromViewer, type ExportPdfDeps } from './export-pdf-tool.ts';
import { planMove } from './move-plan.ts';
import type { DocumentSession, OpenedDocument } from './session.ts';

// 사람 편집 요청 자체의 거부는 Claude 에게 가지 않아 사람용 문구 그대로다
export const STALE_USER_EDIT = USER_REJECTION_MESSAGES.stale_document(undefined);
export const LATE_USER_REQUEST = USER_REJECTION_MESSAGES.late_request(undefined);
export const UNKNOWN_VIEWER_BLOCK = USER_REJECTION_MESSAGES.unknown_block(undefined);
/** 편집 기록 이름 뒤에 붙는 출처. Claude 의 undo 결과에서 사람 편집을 가린다 */
export const USER_EDIT_MARK = ' (사용자 화면 편집)';

function idAt(ids: BlockIdTable, anchor: BlockAnchor): string {
  const id = ids.idAt(anchor);
  if (id === undefined) throw new EditRejection('unknown_block', UNKNOWN_VIEWER_BLOCK);
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
      // 같은 블록이 두 번 와도 한 번만(Claude delete_blocks 와 같게)
      const byId = new Map(edit.targets.map((anchor) => [idAt(ids, anchor), anchor]));
      const targets = [...byId].map(([id, anchor]) => ({ id, anchor }));
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

/** 요청을 받은 순간: 그때 열린 문서와 시각(Date.now) */
export interface Receipt {
  document: OpenedDocument | undefined;
  at: number;
}

/**
 * 줄 차례가 온 문서가 요청을 받은 순간의 문서와 다르면(그사이 그 탭에 같은 파일을 다시 열었거나 새로고침으로 문서가 바뀜) 거부한다.
 * 상태 번호는 문서를 열 때마다 0 부터라 번호만으로는 문서가 바뀐 것을 가리지 못한다(PR #71 리뷰).
 * 다른 문서(다른 탭)를 열거나 만들거나 고친 것은 이 문서를 바꾸지 않는다(SPEC-007 — 문서마다 세션이 따로다).
 * 뷰어는 문서를 바꾼 뒤에야 응답하고 한 연결 안에서는 순서가 지켜지므로, 이전 문서 화면에서 보낸 요청은 서버 문서가 바뀌기 전에 도착한다.
 * 받은 뒤 USER_REQUEST_DEADLINE_MS 넘게 늦게 차례가 와도 거부한다 — 뷰어는 REQUEST_TIMEOUT_MS 뒤 실패를 보여 주므로,
 * 그 뒤에 적용되면 화면 문구와 문서가 어긋난다(PR #71 리뷰)
 */
function assertReceipt(current: OpenedDocument, received: Receipt): void {
  if (current !== received.document) throw new EditRejection('stale_document', STALE_USER_EDIT);
  if (Date.now() - received.at >= USER_REQUEST_DEADLINE_MS) throw new EditRejection('late_request', LATE_USER_REQUEST);
}

/**
 * 사람 편집 하나를 편집 공용 경로로 한다. received 는 요청을 받은 순간(문서·시각), state 는 뷰어가 보고 있던 문서의 상태 번호 —
 * 줄 차례가 왔을 때 문서가 다르거나 서버 번호와 다르면(그사이 Claude 편집·되돌리기가 끼어 문서가 바뀜) 블록 위치가 어긋났을 수 있어
 * 뷰어에 보내지 않고 거부한다(replace_all 과 같은 판정).
 * 편집 순번(depth)이 아니라 상태 번호로 보는 것은, 되돌린 뒤 다른 편집을 하면 순번은 같아도 문서가 다르기 때문이다.
 * 뷰어 번호는 서버가 편집 요청에 실어 보낸 것이라, 뷰어가 적용했지만 서버가 아직 기록하지 않은 편집 뒤의 사람 편집도
 * (줄에서 그 기록 뒤에 차례가 오므로) 맞게 받는다
 */
export async function applyUserEdit(
  session: DocumentSession,
  edit: UserEdit,
  state: number,
  received: Receipt,
): Promise<void> {
  await session.edit((document) => {
    assertReceipt(document, received);
    if (document.edits.state !== state) throw new EditRejection('stale_document', STALE_USER_EDIT);
    const { label, operation, notice } = prepareUserEdit(document.ids, edit);
    return { label: `${label}${USER_EDIT_MARK}`, operation, notice };
  });
}

/**
 * ⌘Z: 공용 되돌리기 줄에서 마지막 편집 하나(사람·Claude 상관없이). 없으면 Claude undo 와 같은 문구로 거부한다.
 * 요청을 받은 뒤 문서가 바뀌었으면 새 문서는 되돌리지 않는다
 */
export async function undoFromViewer(session: DocumentSession, received: Receipt): Promise<UserResult<'user_undo'>> {
  const undone = await session.undo(1, 'user', (document) => assertReceipt(document, received));
  if (undone.length === 0) throw new EditRejection('nothing_to_undo', NOTHING_TO_UNDO);
  return { undone };
}

/** 뷰어 요청 처리(DocumentSessions 가 보낸 탭의 문서 세션으로 부른다). fonts: PDF 버튼이 쓸 글꼴(서버는 시스템 글꼴) */
export async function handleUserRequest(session: DocumentSession, request: UserRequestMessage, fonts: ExportPdfDeps['fonts']): Promise<unknown> {
  // 받은 순간의 문서와 시각(첫 await 전 — bridge 가 메시지를 받은 그 차례에 부른다)
  const received: Receipt = { document: session.document, at: Date.now() };
  switch (request.method) {
    case 'user_edit':
      await applyUserEdit(session, request.params.edit, request.params.state, received);
      return {};
    case 'user_undo':
      return undoFromViewer(session, received);
    case 'user_export_pdf':
      // 편집이 아니라 받은 순간 확인(문서 바뀜·늦음)을 하지 않는다 — 줄 차례가 온 지금 문서를 내보낸다
      return exportPdfFromViewer(session, fonts);
  }
}
