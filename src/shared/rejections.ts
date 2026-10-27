// 편집 거부 코드와 사람용 문구(SPEC-006 "거부 문구", #77).
// 거부 오류의 message 는 Claude(MCP 도구 결과)용이라 블록 id·도구 이름이 든다. 사람 편집(뷰어 user_edit·⌘Z)이 거부되면
// 서버는 같은 오류의 거부 코드로 아래 표의 사람용 문구를 골라 뷰어에 보내고, 뷰어 알림은 그 문구를 보여 준다.
// 뷰어(rhwp 편집)에서 던진 거부도 응답에 코드를 실어 서버로 돌아오므로(protocol.ts) 어디서 거부됐든 같은 표를 쓴다.
import { z } from 'zod';

export const REJECTION_CODES = [
  // 사람 편집 요청 자체
  'stale_document',
  'late_request',
  'unknown_block',
  'inactive_tab',
  'not_ready',
  'unreadable_request',
  'nothing_to_undo',
  // 지우기
  'section_first_paragraph',
  'hidden_objects',
  'controls_unknown',
  'field_block',
  'table_with_field',
  // 옮기기
  'before_section_first',
  'unmovable_paragraph',
  'not_contiguous',
  'field_only',
  'reference_inside',
  'middle_of_paragraph',
  'already_there',
  'different_section',
  // 글자 고치기
  'crosses_field',
] as const;

export const rejectionCodeSchema = z.enum(REJECTION_CODES);
export type RejectionCode = z.infer<typeof rejectionCodeSchema>;

/**
 * 규칙대로 거부한 편집. message 는 Claude 용 문구 그대로, code 로 사람용 문구를 고른다.
 * detail 은 사람용 문구에 넣을 사람이 읽는 말(지울 수 없는 개체 종류·옮길 수 없는 이유) — 블록 id 를 넣지 않는다
 */
export class EditRejection extends Error {
  readonly code: RejectionCode;
  readonly detail: string | undefined;

  constructor(code: RejectionCode, message: string, detail?: string) {
    super(message);
    this.name = 'EditRejection';
    this.code = code;
    this.detail = detail;
  }
}

type Wording = (detail: string | undefined) => string;
const fixed = (text: string): Wording => () => text;

/** 거부 코드 → 사람용 문구. 블록 id·도구 이름을 넣지 않는다(SPEC-006 표와 같게) */
export const USER_REJECTION_MESSAGES: Record<RejectionCode, Wording> = {
  stale_document: fixed('그사이 문서가 바뀌어 적용하지 못했습니다. 다시 고쳐 주세요.'),
  late_request: fixed('docbridge 가 앞선 작업을 처리하느라 늦어져 적용하지 않았습니다. 다시 고쳐 주세요.'),
  unknown_block: fixed('뷰어 화면의 블록을 찾지 못했습니다. 뷰어 탭을 새로고침하세요.'),
  inactive_tab: fixed('다른 뷰어 탭이 이 문서로 docbridge 에 붙어 있어 이 탭에서는 고칠 수 없습니다. 마지막에 연 탭에서 고치세요.'),
  not_ready: fixed('docbridge 가 뷰어 편집을 받을 준비가 되지 않았습니다.'),
  unreadable_request: fixed('docbridge 가 이 요청을 읽지 못했습니다. docbridge 를 다시 띄우고 뷰어 탭을 새로고침하세요.'),
  nothing_to_undo: fixed('되돌릴 편집이 없습니다.'),
  section_first_paragraph: fixed('문서(구역)의 첫 문단은 지울 수 없습니다. 글자를 지우려면 더블클릭해 고치세요.'),
  hidden_objects: (objects) => `이 문단을 지우면 든 개체(${objects ?? '화면에서 고를 수 없는 개체'})도 같이 사라지므로 지울 수 없습니다.`,
  controls_unknown: fixed('이 문단에 든 개체를 확인하지 못해 지울 수 없습니다.'),
  field_block: fixed('누름틀은 따로 지울 수 없습니다. 값을 비우려면 값 위를 더블클릭해 고치세요.'),
  table_with_field: fixed('누름틀이 든 문단에서는 표만 지울 수 없습니다(누름틀이 망가집니다).'),
  before_section_first: fixed('문서(구역)의 첫 문단 앞으로는 옮길 수 없습니다. 첫 문단 뒤로 옮기세요.'),
  unmovable_paragraph: (reasons) => `이 문단은 옮길 수 없습니다(${reasons ?? '옮길 수 없는 개체가 있음'}). 글자만 옮기려면 Claude 에게 부탁하세요.`,
  not_contiguous: fixed('떨어져 있는 블록은 한꺼번에 옮길 수 없습니다. 하나씩 옮기세요.'),
  field_only: fixed('누름틀만 따로 옮길 수 없습니다. 누름틀이 든 문단을 옮기세요.'),
  reference_inside: fixed('옮기는 블록 안으로는 옮길 수 없습니다.'),
  middle_of_paragraph: fixed('한 문단 안의 블록 사이로는 옮길 수 없습니다. 그 문단 앞이나 뒤로 옮기세요.'),
  already_there: fixed('이미 그 자리에 있습니다.'),
  different_section: fixed('다른 구역으로는 옮길 수 없습니다. 같은 구역 안에서 옮기세요.'),
  crosses_field: fixed('누름틀 값과 그 바깥 글자를 한 번에 고칠 수 없습니다. 누름틀 값은 값 위를 더블클릭해 따로 고치세요.'),
};

/** 거부 코드가 없는(예상하지 못한) 실패. Claude 용 문구를 사람에게 그대로 보이지 않는다 */
export const USER_EDIT_FAILED = '화면에서 고치지 못했습니다. 화면이 바뀌지 않았으면 다시 해 주세요.';

export const userRejectionMessage = (code: RejectionCode, detail?: string): string => USER_REJECTION_MESSAGES[code](detail);

/** 사람 편집이 실패한 이유를 사람에게 보일 문구로 */
export function userMessageOf(error: unknown): string {
  return error instanceof EditRejection ? userRejectionMessage(error.code, error.detail) : USER_EDIT_FAILED;
}

/** 응답 메시지에 실을 거부 코드·detail(거부가 아니면 빈 객체) */
export function rejectionFields(error: unknown): { code?: RejectionCode; detail?: string } {
  if (!(error instanceof EditRejection)) return {};
  return error.detail === undefined ? { code: error.code } : { code: error.code, detail: error.detail };
}
