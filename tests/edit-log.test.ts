import { describe, expect, it } from 'vitest';
import { EditLog } from '../src/server/edit-log.ts';

describe('SPEC-002 서버 편집 기록 (되돌리기 칸·저장하지 않은 편집 수)', () => {
  it('편집마다 이름과 편집 전 상태를 쌓고, undo 는 최근 것부터 되돌려 가장 옛 칸의 편집 전 상태를 준다', () => {
    const log = new EditLog<string>();
    log.record('첫 편집', '상태0');
    log.record('둘째 편집', '상태1');
    log.record('셋째 편집', '상태2');

    expect(log.undo(2)).toEqual({ labels: ['셋째 편집', '둘째 편집'], state: '상태1' });
    expect(log.editCount).toBe(1);
  });

  it('되돌릴 것이 없으면 undefined, 있는 것보다 많이 되돌리면 있는 만큼만 되돌린다', () => {
    const log = new EditLog<string>();
    expect(log.undo(1)).toBeUndefined();
    log.record('편집', '상태0');

    expect(log.undo(5)).toEqual({ labels: ['편집'], state: '상태0' });
    expect(log.undo(1)).toBeUndefined();
  });

  it('되돌리기 칸은 20개까지이고 넘으면 가장 옛 칸을 버린다', () => {
    const log = new EditLog<number>();
    for (let i = 0; i < 25; i += 1) log.record(`편집 ${i}`, i);

    expect(log.editCount).toBe(20);
    expect(log.undo(20)?.state).toBe(5);
    expect(log.undo(1)).toBeUndefined();
  });

  it('저장하지 않은 편집 수는 되돌리기 칸과 따로 센다(20개를 넘게 고쳐도 모두 센다)', () => {
    const log = new EditLog<number>();
    for (let i = 0; i < 25; i += 1) log.record(`편집 ${i}`, i);

    expect(log.unsavedEdits).toBe(25);
    expect(log.dirty).toBe(true);
    log.undo(3);
    expect(log.unsavedEdits).toBe(22);
  });

  it('저장하면 0 이 되고, 저장한 뒤 되돌리거나 되돌린 뒤 다른 편집을 하면 저장한 파일과 다른 만큼 센다', () => {
    const log = new EditLog<number>();
    log.record('a', 0);
    log.record('b', 1);
    log.markSaved();
    expect(log.unsavedEdits).toBe(0);
    expect(log.dirty).toBe(false);

    log.undo(1);
    expect(log.unsavedEdits).toBe(1);
    log.record('c', 1);
    // 저장한 상태에서 b 를 되돌리고 c 를 했다: b 되돌림 + c
    expect(log.unsavedEdits).toBe(2);
    log.undo(1);
    expect(log.unsavedEdits).toBe(1);
  });

  it('편집이 없으면 저장하지 않은 편집도 없다', () => {
    const log = new EditLog<number>();
    expect(log.unsavedEdits).toBe(0);
    expect(log.dirty).toBe(false);
    expect(log.editCount).toBe(0);
  });

  it('편집·되돌리기 요청에 실을 "그 뒤의 저장하지 않은 편집 수"는 실제로 기록·되돌린 뒤의 값과 같다 (#22)', () => {
    const log = new EditLog<string>(2);
    const recordChecked = (label: string) => {
      const expected = log.unsavedAfterRecord();
      log.record(label, label);
      expect(log.unsavedEdits).toBe(expected);
    };
    const undoChecked = (steps: number) => {
      const expected = log.unsavedAfterUndo(steps);
      log.undo(steps);
      expect(log.unsavedEdits).toBe(expected);
    };
    recordChecked('가');
    recordChecked('나');
    log.markSaved();
    undoChecked(1);
    recordChecked('다');
    recordChecked('라');
    // 칸(2)보다 많이 되돌리라고 해도 있는 만큼만
    undoChecked(5);
    expect(log.unsavedEdits).toBe(1);
  });

  it('편집·되돌리기 요청에 실을 "그 뒤의 상태 번호"는 실제로 기록·되돌린 뒤의 번호와 같다 (SPEC-006 #58)', () => {
    const log = new EditLog<string>(2);
    expect(log.state).toBe(0);
    const recordChecked = (label: string) => {
      const expected = log.stateAfterRecord();
      log.record(label, label);
      expect(log.state).toBe(expected);
    };
    const undoChecked = (steps: number) => {
      const expected = log.stateAfterUndo(steps);
      log.undo(steps);
      expect(log.state).toBe(expected);
    };
    recordChecked('첫째');
    recordChecked('둘째');
    recordChecked('셋째');
    undoChecked(1);
    recordChecked('넷째');
    // 되돌린 뒤 다른 편집: 순번은 같아도 번호는 새것
    expect(log.depth).toBe(3);
    expect(log.state).toBe(4);
    // 칸(2)보다 많이 되돌리라고 해도 있는 만큼만
    undoChecked(5);
    expect(log.state).toBe(1);
  });
});
