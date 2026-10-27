// move_blocks 계획(SPEC-002): 고른 블록 id 와 기준 블록으로 옮길 본문 문단 범위를 정하고 스펙의 거부 조건을 검사한다.
// 서버 id 표는 뷰어 블록 위치와 같은 순서로 맞춰 두므로(SPEC-001 대응표) 블록 목록 대신 id 표로 한다 —
// 오류에 사이 블록 id 처럼 서버만 아는 id 를 담을 수 있다. rhwp 가 거부하는 문단(각주 등)은 뷰어가 옮길 때 가린다.
import { fieldOrdinal, type BlockAnchor, type BlockIdTable } from '../core/block-ids.ts';
import { unknownIdsMessage } from './reading.ts';

export type MoveWhere = 'before' | 'after';

export interface MovePlan {
  section: number;
  /** 옮길 문단 [start, end) */
  start: number;
  end: number;
  /** 이 문단 앞으로 옮긴다(옮기기 전 번호, 문단 수면 맨 끝) */
  before: number;
  /** 범위에 든 블록 모두(문서 순서). 고르지 않은 같은 문단 블록(문단 안 누름틀 등)도 같이 옮겨진다 */
  blocks: Array<{ id: string; anchor: BlockAnchor }>;
  /** 옛 자리와 새 자리 사이에서 옮긴 문단과 순서가 바뀐 블록 id(문서 순서) — 직접 입력한 번호가 틀어질 수 있는 문단 */
  shifted: string[];
}

export const DIFFERENT_SECTION = '다른 구역으로는 옮길 수 없습니다. 같은 구역 안에서 옮기세요.';

const isField = (anchor: BlockAnchor) => fieldOrdinal(anchor) !== undefined;
const whereName = (where: MoveWhere) => (where === 'before' ? '앞' : '뒤');

export function planMove(ids: BlockIdTable, given: string[], referenceId: string, where: MoveWhere): MovePlan {
  const chosenIds = [...new Set(given)];
  const known = (id: string) => {
    const anchor = ids.anchor(id);
    return anchor === undefined ? [] : [{ id, anchor }];
  };
  const chosen = chosenIds.flatMap(known);
  const [referenceEntry] = known(referenceId);
  if (chosen.length < chosenIds.length || referenceEntry === undefined) {
    const unknown = [...chosenIds, referenceId].filter((id) => ids.anchor(id) === undefined);
    throw new Error(unknownIdsMessage([...new Set(unknown)]));
  }
  const reference = referenceEntry.anchor;
  const section = reference.section;
  if (chosen.some(({ anchor }) => anchor.section !== section)) throw new Error(DIFFERENT_SECTION);

  // 고른 블록을 문단별로 한 번 묶는다
  const chosenByParagraph = new Map<number, Array<{ id: string; anchor: BlockAnchor }>>();
  for (const entry of chosen) {
    const group = chosenByParagraph.get(entry.anchor.paragraph);
    if (group === undefined) chosenByParagraph.set(entry.anchor.paragraph, [entry]);
    else group.push(entry);
  }

  // 이어짐: 고른 블록이 든 문단들이, 블록이 있는 문단을 하나도 건너뛰지 않아야 한다
  const inSection = ids.entries(section);
  const start = Math.min(...chosenByParagraph.keys());
  const last = Math.max(...chosenByParagraph.keys());
  const skipped = inSection.filter(({ anchor }) => start < anchor.paragraph && anchor.paragraph < last && !chosenByParagraph.has(anchor.paragraph));
  if (skipped.length > 0) {
    throw new Error(
      `옮길 블록이 문서에서 이어져 있지 않습니다. 사이 블록 ${skipped.map(({ id }) => id).join(', ')} 도 ids 에 넣거나 따로 옮기세요.`,
    );
  }
  const end = last + 1;
  const blocks = inSection.filter(({ anchor }) => start <= anchor.paragraph && anchor.paragraph < end);

  // 누름틀은 문단째 옮긴다: 누름틀만 골랐는데 그 문단에 문단·표 블록이 있으면 그 블록을 고르게 한다
  for (const [paragraph, chosenHere] of chosenByParagraph) {
    const owner = blocks.find(({ anchor }) => anchor.paragraph === paragraph && !isField(anchor));
    if (owner !== undefined && chosenHere.every(({ anchor }) => isField(anchor))) {
      throw new Error(`${chosenHere.map(({ id }) => id).join(', ')}: 누름틀 블록만 옮길 수는 없습니다. 누름틀이 든 블록 ${owner.id} 를 옮기세요.`);
    }
  }

  if (start <= reference.paragraph && reference.paragraph < end) {
    throw new Error(`기준 블록 ${referenceId} 가 옮길 블록 안에 있습니다.`);
  }
  const before = where === 'before' ? reference.paragraph : reference.paragraph + 1;
  // 이미 그 자리: 블록 순서로 본다. 옮길 범위와 기준 사이에 블록이 든 문단이 없으면 빈 문단 위아래만 바뀐다
  const hasBlockBetween = (from: number, to: number) => inSection.some(({ anchor }) => from < anchor.paragraph && anchor.paragraph < to);
  const alreadyThere =
    (where === 'before' && reference.paragraph >= end && !hasBlockBetween(last, reference.paragraph)) ||
    (where === 'after' && reference.paragraph < start && !hasBlockBetween(reference.paragraph, start));
  if (alreadyThere) {
    throw new Error(`${chosenIds.join(', ')} 은 이미 ${referenceId} ${whereName(where)}에 있습니다. 옮길 것이 없습니다.`);
  }
  const [shiftFrom, shiftTo] = before < start ? [before, start] : [end, before];
  const shifted = inSection.filter(({ anchor }) => shiftFrom <= anchor.paragraph && anchor.paragraph < shiftTo).map(({ id }) => id);
  return { section, start, end, before, blocks, shifted };
}
