// 편집 공용 경로(SPEC-002, ADR 002): 스냅샷 → 편집(edit-operations.ts) → 블록 다시 뽑기 → 바뀐 블록 → 보여 주기(다시 그리기·표시).
// 보여 주기까지 하나라도 던지면 스냅샷으로 되돌려 문서·기록은 그대로다(EditHistory.apply). 성공해야 기록에 들어간다.
// 서버와 뷰어의 편집 기록이 같은 순서로 쌓이는지는 편집 순번(depth)으로 확인한다: 요청마다 서버가 아는 순번을 받아
// 뷰어 순번과 다르면 아무것도 하지 않는다(서버가 결과를 못 받은 편집이 있으면 이후 undo 가 엉뚱한 편집을 되돌린다).
// 뷰어(viewer/main.ts)와 테스트 뷰어(tests/rhwp-viewer.ts)가 같이 쓴다. 열린 문서 하나에 하나.
import type { HwpDocument } from '@rhwp/core';
import { anchorsOf, type BlockAnchor } from './block-ids.ts';
import type { Block } from './block-schema.ts';
import { extractBlocks } from './blocks.ts';
import { EditHistory } from './edit-history.ts';
import { applyEdit, type EditOperation, type ParagraphPosition } from './edit-operations.ts';

export interface ChangedBlock {
  anchor: BlockAnchor;
  block: Block;
}

export const editHistoryMismatchMessage = (server: number, viewer: number) =>
  `편집 기록이 어긋났습니다(서버 ${server}, 뷰어 ${viewer}). open_document 로 문서를 다시 열어 주세요.`;

const positionKey = ({ section, paragraph }: ParagraphPosition) => `${section}:${paragraph}`;

export class DocumentEditor {
  readonly doc: HwpDocument;
  // 되돌리기 이름·상태는 서버(server/edit-log.ts)가 들고, 뷰어는 같은 순서의 스냅샷만 쌓는다
  private readonly history: EditHistory<null>;
  private current: Block[];
  private appliedDepth = 0;

  constructor(doc: HwpDocument) {
    this.doc = doc;
    this.history = new EditHistory<null>(doc);
    this.current = extractBlocks(doc);
  }

  /** 지금 문서의 블록(문서 순서). 편집·되돌리기 때마다 다시 뽑는다 */
  get blocks(): Block[] {
    return this.current;
  }

  /** 편집 순번: 문서를 연 뒤 적용한 편집 수 − 되돌린 수(20칸 상한과 상관없이 센다). 서버 EditLog.depth 와 같아야 한다 */
  get depth(): number {
    return this.appliedDepth;
  }

  /**
   * 편집 하나를 적용하고 바뀐 블록(편집 뒤 위치와 내용)을 돌려준다. show 는 보여 주기(다시 그리기·표시)로, 던지면 편집도 되돌린다.
   * expectedDepth 가 지금 순번과 다르거나 편집이 실패하면 문서는 그대로이고 던진다
   */
  edit(
    operation: EditOperation,
    expectedDepth: number,
    show: (changed: ChangedBlock[], blocks: Block[]) => void = () => undefined,
  ): ChangedBlock[] {
    this.assertDepth(expectedDepth);
    const { changed, blocks } = this.history.apply(operation.kind, null, () => {
      const applied = applyEdit(this.doc, this.current, operation);
      const touched = new Set(applied.paragraphs.map(positionKey));
      // 이미 문단 블록이던(id 가 있는) 문단은 편집으로 비어도 블록으로 남긴다(처음 열 때 빈 문단만 뺀다).
      // #20·#21 처럼 문단 위치가 밀리는 편집은 이 위치 표도 편집에 맞춰 옮겨야 한다
      const next = extractBlocks(this.doc, this.keepParagraphs());
      const result = { changed: changedBlocks(next, touched), blocks: next };
      show(result.changed, next);
      return result;
    });
    this.current = blocks;
    this.appliedDepth += 1;
    return changed;
  }

  /** steps 만큼(있는 만큼만) 되돌리고 되돌린 수를 돌려준다. 되돌릴 것이 없으면 0. expectedDepth 가 다르면 던진다 */
  undo(steps: number, expectedDepth: number): number {
    this.assertDepth(expectedDepth);
    const undone = this.history.undo(steps);
    if (undone === undefined) return 0;
    // 그때 문단 블록이던 문단은 지금 블록 목록에도 있다(비운 문단은 블록으로 남겨 왔다)
    this.current = extractBlocks(this.doc, this.keepParagraphs());
    this.appliedDepth -= undone.labels.length;
    return undone.labels.length;
  }

  /** 문서를 닫기 전에: 스냅샷을 모두 버리고 버린 편집 수를 돌려준다. 문서 핸들은 부르는 쪽이 free 한다 */
  dispose(): number {
    return this.history.dispose();
  }

  /** 지금 문단 블록인 위치: 비어도 블록으로 남긴다 */
  private keepParagraphs(): (section: number, paragraph: number) => boolean {
    const known = new Set(this.current.flatMap((block) => (block.kind === 'paragraph' ? [positionKey(block)] : [])));
    return (section, paragraph) => known.has(positionKey({ section, paragraph }));
  }

  private assertDepth(expected: number): void {
    if (expected !== this.appliedDepth) throw new Error(editHistoryMismatchMessage(expected, this.appliedDepth));
  }
}

/** 바뀐 문단에 걸린 블록(문단 글자·표·누름틀) 모두, 문서 순서대로 */
function changedBlocks(blocks: Block[], touched: Set<string>): ChangedBlock[] {
  const anchors = anchorsOf(blocks);
  return blocks.flatMap((block, i) => {
    const anchor = anchors[i];
    return anchor !== undefined && touched.has(positionKey(block)) ? [{ anchor, block }] : [];
  });
}
