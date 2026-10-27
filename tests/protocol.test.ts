import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  answerRequest,
  REQUEST_TIMEOUT_MS,
  RequestTracker,
  requestMessageSchema,
  textTargetSchema,
  viewerMethodSchemas,
  type RequestMessage,
  type ViewerMethod,
  type ViewerParams,
} from '../src/shared/protocol.ts';

const numberResult = (result: unknown) => z.number().parse(result);

describe('SPEC-001 서버↔뷰어 요청/응답', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('요청마다 다른 id 를 붙이고, 같은 id 의 응답이 오면 그 요청이 결과로 풀린다', async () => {
    const tracker = new RequestTracker();
    const first = tracker.start('load_document', numberResult);
    const second = tracker.start('load_document', numberResult);

    tracker.settle({ type: 'response', id: second.id, ok: true, result: 2 });
    tracker.settle({ type: 'response', id: first.id, ok: true, result: 1 });

    expect(first.id).not.toBe(second.id);
    await expect(first.promise).resolves.toBe(1);
    await expect(second.promise).resolves.toBe(2);
  });

  it('뷰어가 오류로 응답하면 그 이유로 실패한다', async () => {
    const tracker = new RequestTracker();
    const request = tracker.start('load_document', numberResult);

    tracker.settle({ type: 'response', id: request.id, ok: false, error: '손상된 파일입니다' });

    await expect(request.promise).rejects.toThrow('손상된 파일입니다');
  });

  it('정해진 시간 안에 응답이 없으면 타임아웃 오류로 실패한다', async () => {
    const tracker = new RequestTracker();
    const request = tracker.start('load_document', numberResult);
    const outcome = request.promise.then(
      () => 'resolved',
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );

    vi.advanceTimersByTime(REQUEST_TIMEOUT_MS - 1);
    expect(tracker.pendingCount()).toBe(1);
    vi.advanceTimersByTime(1);

    expect(await outcome).toBe(
      `뷰어가 ${REQUEST_TIMEOUT_MS / 1000}초 안에 응답하지 않았습니다(load_document). 뷰어 탭을 확인하고 다시 시도하세요.`,
    );
    expect(tracker.pendingCount()).toBe(0);
  });

  it('뷰어 연결이 끊기면 기다리던 요청을 모두 그 이유로 실패시킨다', async () => {
    const tracker = new RequestTracker();
    const request = tracker.start('load_document', numberResult);

    tracker.failAll(new Error('끊김'));

    await expect(request.promise).rejects.toThrow('끊김');
    expect(tracker.pendingCount()).toBe(0);
  });
});

// 메서드마다 맞는 입력 하나. 메서드를 더하고 여기를 빠뜨리면 타입 검사에서 걸린다
const sampleParams: { [M in ViewerMethod]: ViewerParams<M> } = {
  load_document: { fileName: '공문.hwpx', data: '' },
  get_blocks: {},
  find_text: { query: '회신' },
  highlight: { targets: [{ id: 'b1', anchor: { section: 0, paragraph: 0, part: 'text' }, start: 0, end: 2 }], note: '근거' },
  clear_highlight: {},
  edit: {
    operation: { kind: 'replace_text', target: { id: 'b1', anchor: { section: 0, paragraph: 0, part: 'text' } }, text: '새 글자' },
  },
  undo: { steps: 1 },
};

describe('SPEC-001 뷰어의 요청 처리', () => {
  it('서버가 부르는 모든 메서드의 요청을 뷰어가 읽을 수 있다', () => {
    const methods = Object.keys(viewerMethodSchemas);
    expect(methods.sort()).toEqual(Object.keys(sampleParams).sort());
    for (const [method, params] of Object.entries(sampleParams)) {
      expect(requestMessageSchema.safeParse({ type: 'request', id: 1, method, params }).success).toBe(true);
    }
  });

  const request = (method: string, params: unknown) => JSON.stringify({ type: 'request', id: 7, method, params });
  const methodOf = (message: RequestMessage) => message.method;

  it('요청을 메서드별 입력 모양으로 읽어 처리하고 같은 id 로 응답한다', () => {
    const response = answerRequest(request('load_document', { fileName: '공문.hwpx', data: '' }), methodOf);
    expect(response).toEqual({ type: 'response', id: 7, ok: true, result: 'load_document' });
  });

  it('모르는 메서드의 요청에도 같은 id 의 오류로 응답한다(서버가 타임아웃까지 기다리지 않게)', () => {
    const response = answerRequest(request('rotate_page', {}), methodOf);
    expect(response).toEqual({
      type: 'response',
      id: 7,
      ok: false,
      error: '뷰어가 읽을 수 없는 요청입니다(rotate_page). docbridge 를 다시 띄우고 뷰어 탭을 새로고침하세요.',
    });
  });

  it('입력 모양이 메서드와 맞지 않는 요청에도 오류로 응답한다', () => {
    const response = answerRequest(request('load_document', { query: '회신' }), methodOf);
    expect(response).toMatchObject({ id: 7, ok: false });
  });

  it('처리하다 난 오류는 그 이유로 응답한다', () => {
    const response = answerRequest(request('load_document', { fileName: 'a.hwpx', data: '' }), () => {
      throw new Error('손상된 파일입니다');
    });
    expect(response).toEqual({ type: 'response', id: 7, ok: false, error: '손상된 파일입니다' });
  });

  it('요청 모양이 아닌 메시지에는 응답하지 않는다', () => {
    expect(answerRequest('{"hello":1}', methodOf)).toBeUndefined();
    expect(answerRequest('not json', methodOf)).toBeUndefined();
  });
});

describe('SPEC-001 하이라이트·찾기 공용 대상 (TextTarget)', () => {
  it('블록 id 만, 표 칸, 블록(칸) 안 범위를 대상으로 읽는다', () => {
    expect(textTargetSchema.parse({ id: 'b3' })).toEqual({ id: 'b3' });
    expect(textTargetSchema.parse({ id: 'b12', cell: { row: 2, col: 2 }, start: 5, end: 8 })).toEqual({
      id: 'b12',
      cell: { row: 2, col: 2 },
      start: 5,
      end: 8,
    });
  });

  it('음수나 소수 글자 위치·칸 좌표는 받지 않는다', () => {
    expect(textTargetSchema.safeParse({ id: 'b1', start: -1, end: 2 }).success).toBe(false);
    expect(textTargetSchema.safeParse({ id: 'b1', start: 0.5 }).success).toBe(false);
    expect(textTargetSchema.safeParse({ id: 'b1', cell: { row: -1, col: 0 } }).success).toBe(false);
  });
});
