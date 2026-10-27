// copy_blocks(SPEC-007, ADR 004): 원본 문서의 이어진 블록을 대상 문서에 서식째 넣는다(원본은 그대로).
// 원본 탭이 원본을 HWPX 바이트로 내보내고(save 와 같은 export_hwpx — 다시 열어 블록이 같은지 확인한 바이트) → 서버 → 대상 탭이 그 바이트를 열어 넣는다.
// 대상 쪽은 편집 공용 경로 하나(session.edit — 스냅샷·depth 대조·바뀐 블록·undo 한 번). 원본 범위 규칙은 move_blocks(move-plan.ts planCopySource),
// 대상 기준 규칙은 insert_paragraph(구역 첫 문단 앞 거부). from = to 면 같은 문서 안 사본이다.
import { errorMessage } from '../shared/errors.ts';
import type { ViewerResult } from '../shared/protocol.ts';
import { numberedItem, referenceOf, unmarkedMessage, type NumberedItem } from './edit-tools.ts';
import { anchoredTarget } from './highlight-tools.ts';
import { planCopySource, type BlockRange } from './move-plan.ts';
import type { DocumentSession } from './session.ts';

export interface CopyBlocksArgs {
  /** 원본 블록 id(이어진 범위) */
  ids: string[];
  before?: string;
  after?: string;
}

export interface CopyBlocksResult {
  /** 넣은 블록의 새 id(대상 문서, 문서 순서). 원본 문단의 문단 글자·표·누름틀마다 하나 */
  inserted: string[];
  /** 넣은 블록과 대상에서 번호가 다시 매겨진 문단(number 는 넣은 뒤 자동 번호) */
  changed: NumberedItem[];
  /** 뷰어에 표시하지 못한 블록 */
  warnings?: string[];
}

type SaveExport = ViewerResult<'export_hwpx'>;

/** 원본을 내보내 다시 열었더니 블록이 달랐다(저장 전 검증과 같은 확인) — 바이트의 문단 위치를 믿을 수 없어 복사하지 않는다 */
function exportFailure(source: string, failed: Extract<SaveExport, { verified: false }>): Error {
  const why = failed.reopenError ?? `다시 연 문서와 다른 블록 ${failed.different.length + failed.extraBlocks}개`;
  return new Error(`원본 ${source} 를 HWPX 로 내보내 확인하지 못해 복사하지 않았습니다(${why}).`);
}

/** 편집 이름: 원본 문서와 고른 블록(문서 순서, 셋 이상이면 첫~끝), 대상 기준 */
function copyLabel(source: string, range: BlockRange, given: string[], where: 'before' | 'after', referenceId: string): string {
  const chosen = new Set(given);
  const ids = range.blocks.flatMap(({ id }) => (chosen.has(id) ? [id] : []));
  const shown = ids.length <= 2 ? ids.join(', ') : `${ids[0]}~${ids.at(-1)}`;
  return `copy_blocks ${source} ${shown} → ${where} ${referenceId}`;
}

export async function copyBlocks(source: DocumentSession, target: DocumentSession, { ids, before, after }: CopyBlocksArgs): Promise<CopyBlocksResult> {
  const { referenceId, where } = referenceOf({ before, after });
  // 원본 범위와 바이트는 원본 문서 줄에서 같은 시점에 뜬다(그 뒤 원본이 바뀌어도 바이트 안 위치는 그대로다)
  const { range, data } = await source.exclusive(async (document, send) => {
    let range: BlockRange;
    try {
      range = planCopySource(document.ids, ids);
    } catch (error) {
      throw new Error(`원본 ${source.name}: ${errorMessage(error)}`);
    }
    const exported = await send('export_hwpx', {});
    if (!exported.verified) throw exportFailure(source.name, exported);
    return { range, data: exported.data };
  });
  const { changed, unmarked, inserted } = await target.edit((document) => {
    const { anchor } = anchoredTarget(document.ids, { id: referenceId });
    return {
      label: copyLabel(source.name, range, ids, where, referenceId),
      operation: { kind: 'copy_blocks', source: { data, ...range }, reference: { id: referenceId, anchor }, where },
    };
  });
  return {
    inserted,
    changed: changed.flatMap(numberedItem),
    ...(unmarked.length === 0 ? {} : { warnings: unmarked.map(unmarkedMessage) }),
  };
}
