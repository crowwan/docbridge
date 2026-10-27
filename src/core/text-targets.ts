// TextTarget(블록 id·칸·글자 범위) 공용 도우미. 하이라이트(highlight-targets.ts)·편집(edit-operations.ts)·편집 도구 이름이 같이 쓴다.
import { charLength } from './chars.ts';

interface TargetLike {
  id: string;
  cell?: { row: number; col: number } | undefined;
  start?: number | undefined;
  end?: number | undefined;
}

/** 오류·편집 이름에 쓰는 대상 이름: "b3" 또는 "b12 칸(1,2)" */
export const targetLabel = ({ id, cell }: TargetLike) => (cell === undefined ? id : `${id} 칸(${cell.row},${cell.col})`);

/**
 * 대상의 start·end 를 text 안에서 검사해 [시작, 끝) 으로. 없으면 처음·끝.
 * allowEmpty: 빈 범위(start = end)를 받는지 — 편집은 그 자리에 넣기라 받고, 하이라이트는 칠할 것이 없어 받지 않는다
 */
export function spanIn(target: TargetLike, text: string, { allowEmpty }: { allowEmpty: boolean }): { start: number; end: number } {
  const length = charLength(text);
  const start = target.start ?? 0;
  const end = target.end ?? length;
  const ordered = allowEmpty ? start <= end : start < end;
  if (!ordered || end > length) {
    const rule = allowEmpty ? '0 ≤ start ≤ end ≤ 글자 수' : '0 ≤ start < end ≤ 글자 수';
    throw new Error(`${targetLabel(target)}: 글자 범위가 맞지 않습니다(start ${start}, end ${end}, 글자 수 ${length}). ${rule}로 주세요.`);
  }
  return { start, end };
}
