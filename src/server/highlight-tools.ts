// 근거 하이라이트 도구: 대상의 블록 id 를 서버 id 표의 위치로 바꿔 뷰어에 그리게 한다(session.requestWithDocument).
// 대상이 블록에 맞는지(범위·칸)는 블록 글자를 가진 뷰어가 검사한다(core/highlight-targets.ts).
import type { BlockIdTable } from '../core/block-ids.ts';
import type { AnchoredTarget, TextTarget } from '../shared/protocol.ts';
import { unknownIdsMessage } from './reading.ts';
import type { DocumentSession } from './session.ts';

export interface HighlightResult {
  /** 그린 대상 수 */
  highlighted: number;
  /** 하이라이트가 있는 모든 쪽(1부터, 오름차순). 첫 대상으로 스크롤했다 */
  pages: number[];
  /** 그리긴 했지만 정확하지 않을 수 있는 대상(예: 빈 누름틀 안내문 자리를 못 찾음) */
  warnings?: string[];
}

/** 대상의 블록 id 를 id 표의 위치로 바꾼다. 없는 id 가 있으면 모두 모아 던진다(뷰어에 보내기 전에) */
export function anchored(ids: BlockIdTable, targets: TextTarget[]): AnchoredTarget[] {
  const unknown = targets.filter((target) => ids.anchor(target.id) === undefined).map((target) => target.id);
  if (unknown.length > 0) throw new Error(unknownIdsMessage([...new Set(unknown)]));
  return targets.flatMap((target) => {
    const anchor = ids.anchor(target.id);
    return anchor === undefined ? [] : [{ ...target, anchor }];
  });
}

/** 대상 하나의 블록 id 를 id 표 위치로 바꾼다. 없는 id 면 던진다 */
export function anchoredTarget(ids: BlockIdTable, target: TextTarget): AnchoredTarget {
  const anchor = ids.anchor(target.id);
  if (anchor === undefined) throw new Error(unknownIdsMessage([target.id]));
  return { ...target, anchor };
}

export async function highlight(session: DocumentSession, targets: TextTarget[], note?: string): Promise<HighlightResult> {
  const trimmed = note?.trim() ?? '';
  const { pages, warnings } = await session.requestWithDocument('highlight', (document) => ({
    targets: anchored(document.ids, targets),
    ...(trimmed === '' ? {} : { note: trimmed }),
  }));
  return {
    highlighted: targets.length,
    pages: [...new Set(pages)].sort((a, b) => a - b),
    ...(warnings === undefined || warnings.length === 0 ? {} : { warnings }),
  };
}

export async function clearHighlight(session: DocumentSession): Promise<{ cleared: true }> {
  await session.requestViewer('clear_highlight', {});
  return { cleared: true };
}
