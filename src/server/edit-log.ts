// 서버 쪽 편집 기록(SPEC-002, ADR 002 "실제 구성").
// 스냅샷은 문서와 같이 뷰어(core/edit-history.ts)에 있고, 서버는 같은 순서로 {편집 이름, 편집 전 상태(블록 id 표 사본)} 를 쌓는다.
// 되돌리기는 최대 20칸. 저장하지 않은 편집 수(dirty)는 되돌리기 칸과 따로 센다 — 20개를 넘게 고쳐도, 저장 뒤 되돌려도 맞게.
import { BoundedStack } from '../core/bounded-stack.ts';
import { UNDO_LIMIT } from '../core/edit-history.ts';

interface Entry<S> {
  label: string;
  /** 편집 전 상태. 되돌리면 이것으로 돌아간다 */
  before: S;
}

/** 공통 앞부분 길이 */
function commonPrefix(a: number[], b: number[]): number {
  let length = 0;
  while (length < a.length && length < b.length && a[length] === b[length]) length += 1;
  return length;
}

export class EditLog<S> {
  private readonly entries: BoundedStack<Entry<S>>;
  // 문서 상태마다 번호를 붙여 "연 뒤 지나온 상태 줄"을 기억한다(되돌리기 칸과 달리 자르지 않는다. 편집 하나에 숫자 하나).
  // 저장하지 않은 편집 수 = 지금 줄과 저장한 때 줄이 갈라진 뒤의 길이 합
  private chain: number[] = [0];
  private savedChain: number[] = [0];
  private nextState = 1;

  constructor(limit = UNDO_LIMIT) {
    this.entries = new BoundedStack(limit);
  }

  /** 되돌릴 수 있는 편집 수(최대 20) */
  get editCount(): number {
    return this.entries.size;
  }

  /** 마지막으로 열거나 저장한 파일과 지금 문서 사이의 편집 수. 저장한 뒤 되돌린 것도 센다 */
  get unsavedEdits(): number {
    return this.unsavedFor(this.chain);
  }

  /** 편집 하나를 더 기록하면 될 저장하지 않은 편집 수(뷰어 편집 요청에 미리 싣는다) */
  unsavedAfterRecord(): number {
    return this.unsavedFor([...this.chain, this.nextState]);
  }

  /** steps 만큼(있는 만큼만) 되돌리면 될 저장하지 않은 편집 수 */
  unsavedAfterUndo(steps: number): number {
    return this.unsavedFor(this.chain.slice(0, this.chain.length - Math.min(steps, this.entries.size)));
  }

  private unsavedFor(chain: number[]): number {
    const shared = commonPrefix(chain, this.savedChain);
    return chain.length - shared + (this.savedChain.length - shared);
  }

  /** 편집 순번: 연 뒤 적용한 편집 수 − 되돌린 수(20칸 상한과 상관없음). 뷰어 DocumentEditor.depth 와 같아야 한다 */
  get depth(): number {
    return this.chain.length - 1;
  }

  /** 지금 문서 상태 번호. 편집마다 새 번호이고, 되돌리면 그 편집 전 번호로 돌아간다(같은 번호 = 같은 문서) */
  get state(): number {
    return this.chain.at(-1) ?? 0;
  }

  /** 저장하지 않은 편집이 있는지 */
  get dirty(): boolean {
    return this.unsavedEdits > 0;
  }

  /** 뷰어가 편집을 마친 뒤 부른다. 20칸을 넘으면 가장 옛 칸을 버린다(뷰어도 같은 칸의 스냅샷을 버린다) */
  record(label: string, before: S): void {
    this.entries.push({ label, before });
    this.chain.push(this.nextState);
    this.nextState += 1;
  }

  /**
   * steps 만큼(있는 만큼만) 되돌린다. 되돌린 편집 이름(최근 것부터)과 가장 옛 칸의 편집 전 상태.
   * 되돌릴 것이 없으면 undefined
   */
  undo(steps: number): { labels: string[]; state: S } | undefined {
    const taken = this.entries.take(steps);
    const oldest = taken.at(-1);
    if (oldest === undefined) return undefined;
    this.chain = this.chain.slice(0, this.chain.length - taken.length);
    return { labels: taken.map((entry) => entry.label), state: oldest.before };
  }

  /** 저장했을 때: 지금 상태가 "마지막 파일" 상태가 된다. 되돌리기 칸은 그대로 둔다 */
  markSaved(): void {
    this.savedChain = [...this.chain];
  }
}
