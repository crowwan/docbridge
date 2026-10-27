// 편집 되돌리기 — SPEC-002 기술 검증(#18).
// 편집마다 rhwp 문서 스냅샷(saveSnapshot)과, 같이 되돌릴 상태(블록 id 표 사본 등)를 한 칸에 쌓는다.
// 20칸을 넘으면 가장 옛 칸의 스냅샷을 discardSnapshot 으로 버린다(메모리, ADR 002 측정).
import type { HwpDocument } from '@rhwp/core';

export const UNDO_LIMIT = 20;

interface Entry<S> {
  snapshot: number;
  label: string;
  /** 편집 전 상태(되돌리면 이것으로 돌아간다) */
  before: S;
}

export class EditHistory<S> {
  private readonly entries: Array<Entry<S>> = [];
  private readonly doc: HwpDocument;
  private readonly limit: number;

  constructor(doc: HwpDocument, limit = UNDO_LIMIT) {
    this.doc = doc;
    this.limit = limit;
  }

  get size(): number {
    return this.entries.length;
  }

  /**
   * 편집 하나를 적용한다. 편집 전에 스냅샷을 뜨고, 편집이 던지면 스냅샷으로 되돌린 뒤 다시 던진다.
   * changed 가 false 를 돌려주면(거부 결과처럼 문서가 그대로면) 스냅샷을 버리고 기록하지 않는다.
   */
  apply<R>(label: string, before: S, edit: () => R, changed: (result: R) => boolean = () => true): R {
    const snapshot = this.doc.saveSnapshot();
    let result: R;
    try {
      result = edit();
    } catch (error) {
      this.doc.restoreSnapshot(snapshot);
      this.doc.discardSnapshot(snapshot);
      throw error;
    }
    if (!changed(result)) {
      this.doc.discardSnapshot(snapshot);
      return result;
    }
    this.entries.push({ snapshot, label, before });
    while (this.entries.length > this.limit) {
      const oldest = this.entries.shift();
      if (oldest) this.doc.discardSnapshot(oldest.snapshot);
    }
    return result;
  }

  /** steps 만큼 되돌린다. 되돌린 편집 이름(최근 것부터)과 가장 옛 칸의 편집 전 상태. 되돌릴 것이 없으면 undefined */
  undo(steps = 1): { labels: string[]; state: S } | undefined {
    const taken = this.entries.splice(Math.max(0, this.entries.length - steps)).reverse();
    const oldest = taken.at(-1);
    if (oldest === undefined) return undefined;
    this.doc.restoreSnapshot(oldest.snapshot);
    for (const entry of taken) this.doc.discardSnapshot(entry.snapshot);
    return { labels: taken.map((entry) => entry.label), state: oldest.before };
  }

  /** 새 문서를 열 때: 스냅샷을 모두 버리고 버린 편집 수를 돌려준다 */
  clear(): number {
    const count = this.entries.length;
    for (const entry of this.entries) this.doc.discardSnapshot(entry.snapshot);
    this.entries.length = 0;
    return count;
  }
}
