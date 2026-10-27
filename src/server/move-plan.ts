// move_blocks 계획(SPEC-002): 고른 블록 id 와 기준 블록으로 옮길 본문 문단 범위를 정하고 스펙의 거부 조건을 검사한다.
// copy_blocks(SPEC-007)의 원본 범위도 같은 범위 규칙(planRange — 이어짐·누름틀만 고르기 거부)으로 정한다.
// 서버 id 표는 뷰어 블록 위치와 같은 순서로 맞춰 두므로(SPEC-001 대응표) 블록 목록 대신 id 표로 한다 —
// 오류에 사이 블록 id 처럼 서버만 아는 id 를 담을 수 있다. rhwp 가 거부하는 문단(각주 등)은 뷰어가 옮길 때 가린다.
import { fieldOrdinal, type BlockAnchor, type BlockIdTable } from '../core/block-ids.ts';
import { EditRejection } from '../shared/rejections.ts';
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

/** 고른 블록이 든 이어진 문단 범위(한 구역)와 그 안 블록 모두 — 옮기기·복사 공용 범위 규칙 */
export interface BlockRange {
  section: number;
  /** 문단 [start, end) */
  start: number;
  end: number;
  /** 범위에 든 블록 모두(문서 순서). 고르지 않은 같은 문단 블록(문단 안 누름틀 등)과 사이 빈 문단도 범위에 든다 */
  blocks: Array<{ id: string; anchor: BlockAnchor }>;
}

/** 거부 문구의 말(옮길·옮기세요 / 복사할·복사하세요) */
type RangeWords = { will: string; doIt: string };
const MOVE: RangeWords = { will: '옮길', doIt: '옮기세요' };
const COPY: RangeWords = { will: '복사할', doIt: '복사하세요' };

/**
 * 고른 블록이 든 문단 범위. 블록이 있는 문단을 건너뛰면(이어지지 않음), 누름틀만 골랐는데 그 문단에 문단·표 블록이 있으면 거부한다.
 * 없는 id 와 구역은 부르는 쪽이 먼저 본다(move 는 기준 블록과 함께 알린다)
 */
function planRange(ids: BlockIdTable, chosen: Array<{ id: string; anchor: BlockAnchor }>, section: number, words: RangeWords): BlockRange {
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
    throw new EditRejection(
      'not_contiguous',
      `${words.will} 블록이 문서에서 이어져 있지 않습니다. 사이 블록 ${skipped.map(({ id }) => id).join(', ')} 도 ids 에 넣거나 따로 ${words.doIt}.`,
    );
  }
  const end = last + 1;
  const blocks = inSection.filter(({ anchor }) => start <= anchor.paragraph && anchor.paragraph < end);

  // 누름틀은 문단째: 누름틀만 골랐는데 그 문단에 문단·표 블록이 있으면 그 블록을 고르게 한다
  for (const [paragraph, chosenHere] of chosenByParagraph) {
    const owner = blocks.find(({ anchor }) => anchor.paragraph === paragraph && !isField(anchor));
    if (owner !== undefined && chosenHere.every(({ anchor }) => isField(anchor))) {
      throw new EditRejection(
        'field_only',
        `${chosenHere.map(({ id }) => id).join(', ')}: 누름틀 블록만 ${words.will} 수는 없습니다. 누름틀이 든 블록 ${owner.id} 를 ${words.doIt}.`,
      );
    }
  }
  return { section, start, end, blocks };
}

/** id 표에 있는 블록만(같은 id 는 한 번) */
const knownEntries = (ids: BlockIdTable, given: string[]) =>
  [...new Set(given)].flatMap((id) => {
    const anchor = ids.anchor(id);
    return anchor === undefined ? [] : [{ id, anchor }];
  });

export const COPY_DIFFERENT_SECTIONS = '복사할 블록이 여러 구역에 걸쳐 있습니다. 구역마다 나눠 복사하세요.';

/** copy_blocks(SPEC-007): 원본 문서에서 복사할 문단 범위. 범위 규칙은 move_blocks 와 같다 */
export function planCopySource(ids: BlockIdTable, given: string[]): BlockRange {
  const chosen = knownEntries(ids, given);
  const unknown = [...new Set(given)].filter((id) => ids.anchor(id) === undefined);
  if (unknown.length > 0) throw new Error(unknownIdsMessage(unknown));
  const [first] = chosen;
  if (first === undefined) throw new Error(unknownIdsMessage(given));
  if (chosen.some(({ anchor }) => anchor.section !== first.anchor.section)) throw new Error(COPY_DIFFERENT_SECTIONS);
  return planRange(ids, chosen, first.anchor.section, COPY);
}

export function planMove(ids: BlockIdTable, given: string[], referenceId: string, where: MoveWhere): MovePlan {
  const chosenIds = [...new Set(given)];
  const chosen = knownEntries(ids, chosenIds);
  const [referenceEntry] = knownEntries(ids, [referenceId]);
  if (chosen.length < chosenIds.length || referenceEntry === undefined) {
    const unknown = [...chosenIds, referenceId].filter((id) => ids.anchor(id) === undefined);
    throw new Error(unknownIdsMessage([...new Set(unknown)]));
  }
  const reference = referenceEntry.anchor;
  const section = reference.section;
  if (chosen.some(({ anchor }) => anchor.section !== section)) throw new EditRejection('different_section', DIFFERENT_SECTION);
  const { start, end, blocks } = planRange(ids, chosen, section, MOVE);
  const inSection = ids.entries(section);
  const last = end - 1;

  if (start <= reference.paragraph && reference.paragraph < end) {
    throw new EditRejection('reference_inside', `기준 블록 ${referenceId} 가 옮길 블록 안에 있습니다.`);
  }
  // 옮기는 단위는 문단이라, 기준 블록 앞(뒤)에 같은 문단의 다른 블록이 있으면 그 사이로는 옮길 수 없다
  const referenceParagraph = inSection.filter(({ anchor }) => anchor.paragraph === reference.paragraph);
  const edge = where === 'before' ? referenceParagraph[0] : referenceParagraph.at(-1);
  if (edge !== undefined && edge.id !== referenceId) {
    const sameIds = referenceParagraph.map(({ id }) => id);
    throw new EditRejection(
      'middle_of_paragraph',
      `기준 블록 ${referenceId} 는 다른 블록과 같은 문단(${sameIds.join(', ')})에 있어 그 사이로는 옮길 수 없습니다. ${sameIds[0]} 앞이나 ${sameIds.at(-1)} 뒤로 옮기세요.`,
    );
  }
  const before = where === 'before' ? reference.paragraph : reference.paragraph + 1;
  // 이미 그 자리: 블록 순서로 본다. 옮길 범위와 기준 사이에 블록이 든 문단이 없으면 빈 문단 위아래만 바뀐다
  const hasBlockBetween = (from: number, to: number) => inSection.some(({ anchor }) => from < anchor.paragraph && anchor.paragraph < to);
  const alreadyThere =
    (where === 'before' && reference.paragraph >= end && !hasBlockBetween(last, reference.paragraph)) ||
    (where === 'after' && reference.paragraph < start && !hasBlockBetween(reference.paragraph, start));
  if (alreadyThere) {
    throw new EditRejection('already_there', `${chosenIds.join(', ')} 은 이미 ${referenceId} ${whereName(where)}에 있습니다. 옮길 것이 없습니다.`);
  }
  const [shiftFrom, shiftTo] = before < start ? [before, start] : [end, before];
  const shifted = inSection.filter(({ anchor }) => shiftFrom <= anchor.paragraph && anchor.paragraph < shiftTo).map(({ id }) => id);
  return { section, start, end, before, blocks, shifted };
}
