// 상한 있는 스택 — 되돌리기 칸(SPEC-002 최대 20단계). 뷰어 스냅샷 기록(edit-history.ts)과 서버 편집 기록(server/edit-log.ts)이 같이 쓴다.
// 넘쳐서 빠진 것·꺼낸 것·비운 것을 돌려줘 쓰는 쪽이 정리(스냅샷 버리기 등)를 한다.
export class BoundedStack<T> {
  private readonly items: T[] = [];
  private readonly limit: number;

  constructor(limit: number) {
    this.limit = limit;
  }

  get size(): number {
    return this.items.length;
  }

  /** 하나를 쌓는다. 상한을 넘으면 가장 옛 것부터 빼서 돌려준다 */
  push(item: T): T[] {
    this.items.push(item);
    return this.items.splice(0, Math.max(0, this.items.length - this.limit));
  }

  /** 최근 것부터 n 개(있는 만큼만)를 꺼낸다 */
  take(n: number): T[] {
    return this.items.splice(Math.max(0, this.items.length - n)).reverse();
  }

  /** 모두 꺼낸다(쌓인 순서) */
  clear(): T[] {
    return this.items.splice(0);
  }
}
