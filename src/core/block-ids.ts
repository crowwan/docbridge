// 블록 id 대응표.
// rhwp 의 문단 주소는 (구역, 문단) 위치 인덱스뿐이고 편집하면 뒤 번호가 밀린다
// (rhwp-code-analysis 2-6). 그래서 문서를 열 때 블록마다 짧은 id 를 붙이고,
// docbridge 가 문단을 넣거나 지울 때마다 대응표의 위치를 같이 옮긴다.
import type { BlockPosition, TextBlockPosition } from './block-schema.ts';

export type { BlockPosition } from './block-schema.ts';

export interface BlockAnchor {
  section: number;
  paragraph: number;
  /** 같은 문단에 걸린 여러 블록(문단 자신, 표, 누름틀)을 가르는 꼬리표 */
  part: string;
}

function anchorOf(block: BlockPosition, partIndex: number): BlockAnchor {
  const { section, paragraph } = block;
  switch (block.kind) {
    case 'paragraph':
      return { section, paragraph, part: 'text' };
    case 'table':
      return { section, paragraph, part: `table:${block.controlIndex}` };
    case 'field':
      return { section, paragraph, part: `field:${partIndex}` };
  }
}

const anchorKey = ({ section, paragraph, part }: BlockAnchor) => `${section}:${paragraph}:${part}`;

/**
 * 블록 목록의 위치 → 순서 찾기. 뷰어가 서버 id 표의 위치(anchor)로 자기 블록을 찾을 때 쓴다.
 * 위치 표는 한 번만 만들어 두고 여러 번 찾는다(요청 하나에 한 번 만든다)
 */
export function blockIndexByAnchor(blocks: BlockPosition[]): (anchor: BlockAnchor) => number | undefined {
  const indexByKey = new Map(anchorsOf(blocks).map((anchor, index) => [anchorKey(anchor), index]));
  return (anchor) => indexByKey.get(anchorKey(anchor));
}

/** 누름틀 위치의 "같은 문단 안 몇 번째 누름틀"(0부터). 누름틀 위치가 아니면 undefined */
export function fieldOrdinal(anchor: BlockAnchor): number | undefined {
  const match = /^field:(\d+)$/.exec(anchor.part);
  return match?.[1] === undefined ? undefined : Number(match[1]);
}

/** 블록 목록의 각 블록 위치. 누름틀은 같은 문단 안에서 몇 번째인지로 가른다 */
export function anchorsOf(blocks: BlockPosition[]): BlockAnchor[] {
  const fieldCount = new Map<string, number>();
  return blocks.map((block) => {
    const at = `${block.section}:${block.paragraph}`;
    const partIndex = fieldCount.get(at) ?? 0;
    if (block.kind === 'field') fieldCount.set(at, partIndex + 1);
    return anchorOf(block, partIndex);
  });
}

export class BlockIdTable {
  private readonly anchors = new Map<string, BlockAnchor>();
  private nextNumber = 1;
  /** 위치 키 → id 역맵. 처음 찾을 때 만들고 위치가 바뀌면(문단 넣기·지우기) 버린다 */
  private idByKey: Map<string, string> | undefined;

  /** 문서를 열 때 블록마다 b1, b2 … 를 문서 순서대로 붙인다 */
  static assign(blocks: BlockPosition[]): BlockIdTable {
    const table = new BlockIdTable();
    for (const anchor of anchorsOf(blocks)) {
      table.anchors.set(`b${table.nextNumber}`, anchor);
      table.nextNumber += 1;
    }
    return table;
  }

  anchor(id: string): BlockAnchor | undefined {
    return this.anchors.get(id);
  }

  /** 문단·표 블록 위치의 id. 누름틀은 같은 문단 안 순서가 필요해 label 로 붙인다 */
  idOf(position: TextBlockPosition): string | undefined {
    return this.idsByKey().get(anchorKey(anchorOf(position, 0)));
  }

  /** 위치(누름틀 포함)의 id */
  idAt(anchor: BlockAnchor): string | undefined {
    return this.idsByKey().get(anchorKey(anchor));
  }

  private idsByKey(): Map<string, string> {
    this.idByKey ??= new Map([...this.anchors].map(([id, anchor]) => [anchorKey(anchor), id]));
    return this.idByKey;
  }

  /** 지금 문서에서 다시 뽑은 블록 목록에 id 를 붙여 돌려준다 */
  label<B extends BlockPosition>(blocks: B[]): Array<{ id: string | undefined; block: B }> {
    const idByAnchor = this.idsByKey();
    const anchors = anchorsOf(blocks);
    return blocks.map((block, i) => {
      const anchor = anchors[i];
      return { id: anchor === undefined ? undefined : idByAnchor.get(anchorKey(anchor)), block };
    });
  }

  /** 문단을 index 자리에 넣은 뒤: 그 자리부터 뒤 문단들의 위치를 하나씩 민다. 새 문단에 새 id 를 준다 */
  paragraphInserted(section: number, index: number): string {
    this.shift(section, index, 1);
    this.idByKey = undefined;
    const id = `b${this.nextNumber}`;
    this.nextNumber += 1;
    this.anchors.set(id, { section, paragraph: index, part: 'text' });
    return id;
  }

  /** index 문단을 지운 뒤: 그 문단의 id 들을 없애고 뒤 문단들의 위치를 하나씩 당긴다 */
  paragraphDeleted(section: number, index: number): void {
    for (const [id, anchor] of this.anchors) {
      if (anchor.section === section && anchor.paragraph === index) this.anchors.delete(id);
    }
    this.shift(section, index + 1, -1);
    this.idByKey = undefined;
  }

  /**
   * 이어진 문단 [start, end) 를 before 문단 앞으로 옮긴 뒤(edits.ts moveParagraphs): 옮긴 문단의 id 는 그대로 새 자리로,
   * 사이 문단들은 옮긴 수만큼 밀리거나 당겨진다
   */
  paragraphsMoved(section: number, start: number, end: number, before: number): void {
    const size = end - start;
    const movedStart = before <= start ? before : before - size;
    const moved = (p: number): number => {
      if (start <= p && p < end) return movedStart + (p - start);
      if (before <= start && before <= p && p < start) return p + size;
      if (before >= end && end <= p && p < before) return p - size;
      return p;
    };
    for (const anchor of this.anchors.values()) {
      if (anchor.section === section) anchor.paragraph = moved(anchor.paragraph);
    }
    this.idByKey = undefined;
  }

  /** 되돌리기용 사본. 편집 전 표를 떠 두었다가 undo 때 그대로 돌려놓는다 */
  clone(): BlockIdTable {
    const copy = new BlockIdTable();
    for (const [id, anchor] of this.anchors) copy.anchors.set(id, { ...anchor });
    copy.nextNumber = this.nextNumber;
    return copy;
  }

  private shift(section: number, from: number, delta: number): void {
    for (const anchor of this.anchors.values()) {
      if (anchor.section === section && anchor.paragraph >= from) anchor.paragraph += delta;
    }
  }
}
