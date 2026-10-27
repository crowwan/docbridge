// SPEC-006 사람 편집 거부 문구(#77): 거부 코드 → 사람용 문구 표, 뷰어 → 서버 응답의 거부 코드 실어 나르기.
import { describe, expect, it } from 'vitest';
import { BlockIdTable, type BlockPosition } from '../src/core/block-ids.ts';
import type { BodyControl } from '../src/core/body-paragraphs.ts';
import { assertNoHiddenObjects } from '../src/core/delete-blocks.ts';
import { isKnownMoveReason, moveRejectReason } from '../src/core/edits.ts';
import { planMove } from '../src/server/move-plan.ts';
import { answerRequest, RequestTracker } from '../src/shared/protocol.ts';
import {
  EditRejection,
  REJECTION_CODES,
  USER_EDIT_FAILED,
  userMessageOf,
  userRejectionMessage,
} from '../src/shared/rejections.ts';

/** 사람에게 보이면 안 되는 것: 블록 id(b12)·Claude 도구 이름 */
const CLAUDE_ONLY = /\bb\d+\b|replace_text|replace_all|insert_paragraph|insert_table|delete_blocks|move_blocks|copy_blocks|get_outline|read_blocks|open_document|find_text/;

describe('SPEC-006 사람 편집 거부 문구 표 (#77)', () => {
  it.each(REJECTION_CODES)('%s 사람용 문구에는 블록 id·도구 이름이 없다', (code) => {
    expect(userRejectionMessage(code)).not.toMatch(CLAUDE_ONLY);
    expect(userRejectionMessage(code, '각주')).not.toMatch(CLAUDE_ONLY);
  });

  it('개체 종류·옮길 수 없는 이유(detail)는 사람 문구 안에 넣는다', () => {
    expect(userRejectionMessage('hidden_objects', '감추기')).toBe('이 문단을 지우면 든 개체(감추기)도 같이 사라지므로 지울 수 없습니다.');
    expect(userRejectionMessage('unmovable_paragraph', '각주, 책갈피')).toBe(
      '이 문단은 옮길 수 없습니다(각주, 책갈피). 글자만 옮기려면 Claude 에게 부탁하세요.',
    );
  });

  it('거부 오류는 코드의 사람 문구, 거부 코드가 없는 오류는 일반 문구다(Claude 용 message 를 쓰지 않는다)', () => {
    const rejection = new EditRejection('already_there', 'b5 은 이미 b4 뒤에 있습니다. 옮길 것이 없습니다.');
    expect(rejection.message).toBe('b5 은 이미 b4 뒤에 있습니다. 옮길 것이 없습니다.');
    expect(userMessageOf(rejection)).toBe('이미 그 자리에 있습니다.');
    expect(userMessageOf(new Error('b3: 뷰어 문서에 이 블록이 없습니다. get_outline 을 다시 부르세요.'))).toBe(USER_EDIT_FAILED);
  });

  /** fn 이 던진 것(던지지 않으면 undefined) */
  const thrownBy = (fn: () => void): unknown => {
    try {
      fn();
    } catch (error) {
      return error;
    }
    return undefined;
  };

  it('지울 수 없는 개체에 종류 이름이 없으면 rhwp 컨트롤 코드 대신 "개체" 로 부른다(Claude 문구에는 코드 그대로)', () => {
    const control = (ctrlId: string, userDesc: string): BodyControl => ({ section: 0, paragraph: 3, ctrlId, userDesc, list: 0, para: 3, controlIndex: 0 });
    const rejected = thrownBy(() => assertNoHiddenObjects([control('pghd', '감추기'), control('zzzz', '')], 'b4'));

    expect(rejected).toBeInstanceOf(EditRejection);
    expect(userMessageOf(rejected)).toBe('이 문단을 지우면 든 개체(감추기, 개체)도 같이 사라지므로 지울 수 없습니다.');
    expect(rejected instanceof Error ? rejected.message : '').toContain('(감추기, zzzz)');
  });

  it('우리 말로 옮겨 둔 옮기기 거부 이유만 사람 문구에 넣고, rhwp 원문 이유는 일반 문구로', () => {
    expect(isKnownMoveReason(moveRejectReason('paragraph block: Footnote'))).toBe(true);
    expect(isKnownMoveReason(moveRejectReason('paragraph block: SomethingNew'))).toBe(false);
    expect(isKnownMoveReason('문서 사본을 만들지 못했습니다: rhwp 오류')).toBe(false);
    expect(userRejectionMessage('unmovable_paragraph')).toBe('이 문단은 옮길 수 없습니다(옮길 수 없는 개체가 있음). 글자만 옮기려면 Claude 에게 부탁하세요.');
  });

  it('다른 구역으로 옮기기 거부는 different_section 이다', () => {
    const positions: BlockPosition[] = [
      { kind: 'paragraph', section: 0, paragraph: 1 },
      { kind: 'paragraph', section: 1, paragraph: 1 },
    ];
    const rejected = thrownBy(() => planMove(BlockIdTable.assign(positions), ['b1'], 'b2', 'after'));
    expect(rejected).toBeInstanceOf(EditRejection);
    expect(userMessageOf(rejected)).toBe(userRejectionMessage('different_section'));
  });
});

describe('SPEC-006 뷰어 거부의 코드를 서버로 (#77)', () => {
  const viewerRequest = JSON.stringify({ type: 'request', id: 3, method: 'get_blocks', params: {} });

  it('뷰어 응답에 거부 코드·detail 을 싣고, 서버는 같은 코드의 거부 오류로 되살린다', async () => {
    const response = answerRequest(viewerRequest, () => {
      throw new EditRejection('hidden_objects', 'b6: 문단에 블록이 아닌 개체(각주)가 있어 같이 사라지므로 지울 수 없습니다.', '각주');
    });
    expect(response).toEqual({
      type: 'response',
      id: 3,
      ok: false,
      error: 'b6: 문단에 블록이 아닌 개체(각주)가 있어 같이 사라지므로 지울 수 없습니다.',
      code: 'hidden_objects',
      detail: '각주',
    });

    const tracker = new RequestTracker();
    const { id, promise } = tracker.start('edit', () => ({}));
    if (response === undefined || response.ok) throw new Error('거부 응답이 아니다');
    tracker.settle({ ...response, id });
    const error = await promise.then(
      () => undefined,
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(EditRejection);
    expect(userMessageOf(error)).toBe('이 문단을 지우면 든 개체(각주)도 같이 사라지므로 지울 수 없습니다.');
  });

  it('거부가 아닌 뷰어 오류에는 코드를 싣지 않는다', () => {
    expect(answerRequest(viewerRequest, () => {
      throw new Error('rhwp 오류');
    })).toEqual({ type: 'response', id: 3, ok: false, error: 'rhwp 오류' });
  });
});
