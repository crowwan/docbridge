import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { REQUEST_TIMEOUT_MS, RequestTracker } from '../src/shared/protocol.ts';

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
