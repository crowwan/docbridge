// 문단 수를 바꾸는 편집(넣기·지우기, #21 옮기기)이 실제로 한 일.
// 뷰어가 편집하고 이것을 결과에 실어 보내면, 서버는 이것으로 블록 id 표를 옮기고(server/session.ts)
// 뷰어는 같은 것으로 "블록으로 남길 빈 문단" 위치를 옮긴다(document-editor.ts). 서버가 따로 계산하지 않으므로 둘이 어긋나지 않는다.
import { z } from 'zod';

/** 본문 문단 위치 */
export interface ParagraphPosition {
  section: number;
  paragraph: number;
}

/** 문단 위치 키("구역:문단"). 위치를 Set·Map 에 넣을 때 쓴다 */
export const positionKey = ({ section, paragraph }: ParagraphPosition) => `${section}:${paragraph}`;

const positionSchema = z.object({ section: z.number().int().min(0), paragraph: z.number().int().min(0) });

export const paragraphChangesSchema = z.object({
  /** 문단은 두고 표 컨트롤만 지운 자리(편집 전 위치와 컨트롤 번호) */
  deletedTables: z.array(positionSchema.extend({ controlIndex: z.number().int().min(0) })),
  /** 통째로 지운 문단(편집 전 위치, 문서 순서) */
  deletedParagraphs: z.array(positionSchema),
  /** 새로 넣은 문단(편집 뒤 위치, 문서 순서). 지우기 다음에 넣은 것으로 본다 */
  inserted: z.array(positionSchema),
});
export type ParagraphChanges = z.infer<typeof paragraphChangesSchema>;

export const noParagraphChanges = (): ParagraphChanges => ({ deletedTables: [], deletedParagraphs: [], inserted: [] });

/** 오름차순 배열에서 value 보다 작은 값의 수(이진 탐색) */
function countBelow(sorted: number[], value: number): number {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if ((sorted[middle] ?? Infinity) < value) low = middle + 1;
    else high = middle;
  }
  return low;
}

function bySection(positions: ParagraphPosition[]): Map<number, number[]> {
  const grouped = new Map<number, number[]>();
  for (const { section, paragraph } of positions) grouped.set(section, [...(grouped.get(section) ?? []), paragraph]);
  for (const list of grouped.values()) list.sort((a, b) => a - b);
  return grouped;
}

/**
 * relocate: 편집 전 문단 위치 → 편집 뒤 위치. 통째로 지운 문단은 undefined.
 * 지운 문단 수만큼 당긴 뒤, 넣은 문단(편집 뒤 위치, 오름차순) 자리마다 그 자리부터 하나씩 민다.
 * 표만 지운 자리는 문단 위치가 바뀌지 않는다(같은 문단 표 컨트롤 번호만 당겨진다 — id 표 tableDeleted).
 * 서버 id 표(block-ids.ts paragraphDeleted·paragraphInserted)가 같은 순서로 같은 결과를 낸다
 */
export function relocate(changes: ParagraphChanges): (position: ParagraphPosition) => ParagraphPosition | undefined {
  const deleted = bySection(changes.deletedParagraphs);
  const inserted = bySection(changes.inserted);
  const deletedKeys = new Set(changes.deletedParagraphs.map(positionKey));
  return (position) => {
    if (deletedKeys.has(positionKey(position))) return undefined;
    let paragraph = position.paragraph - countBelow(deleted.get(position.section) ?? [], position.paragraph);
    for (const at of inserted.get(position.section) ?? []) {
      if (paragraph >= at) paragraph += 1;
    }
    return { section: position.section, paragraph };
  };
}
