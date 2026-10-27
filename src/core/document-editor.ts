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
import { applyEdit, type EditApplied, type EditOperation } from './edit-operations.ts';
import { positionKey, relocate, TEXT_PART, type ParagraphChanges, type ParagraphPosition } from './paragraph-changes.ts';

export interface ChangedBlock {
  anchor: BlockAnchor;
  block: Block;
}

/** 편집 하나의 결과: 바뀐 블록과, 문단 수를 바꾼 편집이면 실제로 넣고 지운 문단·표(서버가 id 표를 이것으로 옮긴다) */
export interface EditOutcome {
  changed: ChangedBlock[];
  changes?: ParagraphChanges;
}

/** 편집 전 문단 위치 → 편집 뒤 위치(지운 문단은 undefined) */
type Relocate = (position: ParagraphPosition) => ParagraphPosition | undefined;

export const editHistoryMismatchMessage = (server: number, viewer: number) =>
  `편집 기록이 어긋났습니다(서버 ${server}, 뷰어 ${viewer}). open_document 로 문서를 다시 열어 주세요.`;

export class DocumentEditor {
  readonly doc: HwpDocument;
  // 되돌리기 이름·id 표는 서버(server/edit-log.ts)가 들고, 뷰어는 같은 순서의 스냅샷과 편집 전 블록 목록을 쌓는다
  private readonly history: EditHistory<Block[]>;
  private current: Block[];
  private appliedDepth = 0;

  constructor(doc: HwpDocument) {
    this.doc = doc;
    this.history = new EditHistory<Block[]>(doc);
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
   * 편집 하나를 적용하고 바뀐 블록(편집 뒤 위치와 내용)과 넣고 지운 문단·표를 돌려준다. show 는 보여 주기(다시 그리기·표시)로, 던지면 편집도 되돌린다.
   * expectedDepth 가 지금 순번과 다르거나 편집이 실패하면 문서는 그대로이고 던진다
   */
  edit(
    operation: EditOperation,
    expectedDepth: number,
    show: (changed: ChangedBlock[], blocks: Block[]) => void = () => undefined,
  ): EditOutcome {
    this.assertDepth(expectedDepth);
    const { changed, blocks, changes } = this.history.apply(operation.kind, this.current, () => {
      const applied = applyEdit(this.doc, this.current, operation);
      const toAfter = applied.changes === undefined ? (position: ParagraphPosition) => position : relocate(applied.changes);
      // 이미 문단 블록이던(id 가 있는) 문단과 새로 넣은 문단은 편집으로 비어도 블록으로 남긴다(처음 열 때 빈 문단만 뺀다).
      // 문단을 넣고 지우고 옮기는 편집은 그 위치를 편집 뒤 위치로 옮긴다(paragraph-changes.ts relocate)
      const next = extractBlocks(this.doc, this.keepParagraphs(applied, toAfter));
      // 바뀐 블록 = 편집한 문단 + 자동 번호가 바뀐 문단(옮기기처럼 번호가 다시 매겨지면 편집 대상 밖까지 번진다)
      const touched = new Set([...applied.paragraphs.map(positionKey), ...renumberedParagraphs(this.current, next, toAfter)]);
      const result = { changed: changedBlocks(next, touched), blocks: next, changes: applied.changes };
      show(result.changed, next);
      return result;
    });
    this.current = blocks;
    this.appliedDepth += 1;
    return changes === undefined ? { changed } : { changed, changes };
  }

  /** steps 만큼(있는 만큼만) 되돌리고 되돌린 수를 돌려준다. 되돌릴 것이 없으면 0. expectedDepth 가 다르면 던진다 */
  undo(steps: number, expectedDepth: number): number {
    this.assertDepth(expectedDepth);
    const undone = this.history.undo(steps);
    if (undone === undefined) return 0;
    // 스냅샷은 문서를 그 편집 전 그대로 돌려놓으므로 그때 뽑아 둔 블록 목록이 맞다
    // (다시 뽑으면 문단을 넣고 지운 편집 뒤의 위치로 "남길 빈 문단"을 고르게 된다)
    this.current = undone.state;
    this.appliedDepth -= undone.labels.length;
    return undone.labels.length;
  }

  /** 문서를 닫기 전에: 스냅샷을 모두 버리고 버린 편집 수를 돌려준다. 문서 핸들은 부르는 쪽이 free 한다 */
  dispose(): number {
    return this.history.dispose();
  }

  /** 편집 뒤 블록으로 남길 문단: 지금 문단 블록인 위치(편집 뒤 위치로 옮김)와 새로 넣은 문단. 비어도 블록으로 남긴다 */
  private keepParagraphs(applied: EditApplied, toAfter: Relocate): (section: number, paragraph: number) => boolean {
    const known = new Set(
      this.current.flatMap((block) => {
        if (block.kind !== 'paragraph') return [];
        const after = toAfter(block);
        return after === undefined ? [] : [positionKey(after)];
      }),
    );
    // 표를 담으려고 넣은 문단(insert_table, part 'table:N')은 표 블록이 생기므로 빈 문단 블록으로 남기지 않는다
    for (const position of applied.changes?.inserted ?? []) if (position.part === TEXT_PART) known.add(positionKey(position));
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

/** 편집 전과 뒤에 자동 번호 문자열이 다른 문단(편집 뒤 위치 키). 편집 전 문단 블록만 본다(새로 넣은 문단은 편집한 문단이다) */
function renumberedParagraphs(before: Block[], after: Block[], toAfter: Relocate): string[] {
  const numberBefore = new Map<string, string | undefined>();
  for (const block of before) {
    if (block.kind !== 'paragraph') continue;
    const position = toAfter(block);
    if (position !== undefined) numberBefore.set(positionKey(position), block.number);
  }
  return after.flatMap((block) => {
    if (block.kind !== 'paragraph') return [];
    const key = positionKey(block);
    return numberBefore.has(key) && numberBefore.get(key) !== block.number ? [key] : [];
  });
}
