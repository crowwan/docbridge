// 편집 공용 경로(SPEC-002, ADR 002): 스냅샷 → 편집(edit-operations.ts) → 블록 다시 뽑기 → 바뀐 블록.
// 하나라도 던지면 스냅샷으로 되돌려 문서는 그대로다(EditHistory.apply). 다시 그리기·바뀐 블록 표시는 부르는 쪽(뷰어)이 한다.
// 뷰어(viewer/main.ts)와 테스트 뷰어(tests/rhwp-viewer.ts)가 같이 쓴다. 열린 문서 하나에 하나.
import type { HwpDocument } from '@rhwp/core';
import { blockIndexByAnchor, type BlockAnchor } from './block-ids.ts';
import type { Block } from './block-schema.ts';
import { extractBlocks } from './blocks.ts';
import { EditHistory } from './edit-history.ts';
import { applyEdit, type EditOperation } from './edit-operations.ts';

export interface ChangedBlock {
  anchor: BlockAnchor;
  block: Block;
}

export class DocumentEditor {
  readonly doc: HwpDocument;
  // 되돌리기 이름·상태는 서버(server/edit-log.ts)가 들고, 뷰어는 같은 순서의 스냅샷만 쌓는다
  private readonly history: EditHistory<null>;
  private current: Block[];

  constructor(doc: HwpDocument) {
    this.doc = doc;
    this.history = new EditHistory<null>(doc);
    this.current = extractBlocks(doc);
  }

  /** 지금 문서의 블록(문서 순서). 편집·되돌리기 때마다 다시 뽑는다 */
  get blocks(): Block[] {
    return this.current;
  }

  /** 편집 하나를 적용하고 바뀐 블록(편집 뒤 위치와 내용)을 돌려준다. 실패하면 문서는 그대로이고 던진다 */
  edit(operation: EditOperation): ChangedBlock[] {
    const { changed, blocks } = this.history.apply(operation.kind, null, () => {
      const applied = applyEdit(this.doc, this.current, operation);
      // 블록을 못 뽑으면 그 편집도 되돌린다
      return { changed: applied.changed, blocks: extractBlocks(this.doc) };
    });
    this.current = blocks;
    const indexOf = blockIndexByAnchor(blocks);
    return changed.flatMap((anchor) => {
      const index = indexOf(anchor);
      const block = index === undefined ? undefined : blocks[index];
      return block === undefined ? [] : [{ anchor, block }];
    });
  }

  /** steps 만큼(있는 만큼만) 되돌리고 되돌린 수를 돌려준다. 되돌릴 것이 없으면 0 */
  undo(steps: number): number {
    const undone = this.history.undo(steps);
    if (undone === undefined) return 0;
    this.current = extractBlocks(this.doc);
    return undone.labels.length;
  }

  /** 문서를 닫기 전에: 스냅샷을 모두 버리고 버린 편집 수를 돌려준다. 문서 핸들은 부르는 쪽이 free 한다 */
  dispose(): number {
    return this.history.dispose();
  }
}
