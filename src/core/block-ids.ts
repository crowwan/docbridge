// 블록 id 대응표.
// rhwp 의 문단 주소는 (구역, 문단) 위치 인덱스뿐이고 편집하면 뒤 번호가 밀린다
// (rhwp-code-analysis 2-6). 그래서 문서를 열 때 블록마다 짧은 id 를 붙이고,
// docbridge 가 문단을 넣거나 지울 때마다 대응표의 위치를 같이 옮긴다.
import type { Block } from './blocks.ts';

export interface BlockAnchor {
  section: number;
  paragraph: number;
  /** 같은 문단에 걸린 여러 블록(문단 자신, 표, 누름틀)을 가르는 꼬리표 */
  part: string;
}

function anchorOf(block: Block, partIndex: number): BlockAnchor {
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

/** 블록 목록의 각 블록 위치. 누름틀은 같은 문단 안에서 몇 번째인지로 가른다 */
function anchorsOf(blocks: Block[]): BlockAnchor[] {
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

  /** 문서를 열 때 블록마다 b1, b2 … 를 문서 순서대로 붙인다 */
  static assign(blocks: Block[]): BlockIdTable {
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

  /** 지금 문서에서 다시 뽑은 블록 목록에 id 를 붙여 돌려준다 */
  label(blocks: Block[]): Array<{ id: string | undefined; block: Block }> {
    const idByAnchor = new Map([...this.anchors].map(([id, anchor]) => [anchorKey(anchor), id]));
    const anchors = anchorsOf(blocks);
    return blocks.map((block, i) => {
      const anchor = anchors[i];
      return { id: anchor === undefined ? undefined : idByAnchor.get(anchorKey(anchor)), block };
    });
  }

  /** 문단을 index 자리에 넣은 뒤: 그 자리부터 뒤 문단들의 위치를 하나씩 민다. 새 문단에 새 id 를 준다 */
  paragraphInserted(section: number, index: number): string {
    this.shift(section, index, 1);
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
  }

  private shift(section: number, from: number, delta: number): void {
    for (const anchor of this.anchors.values()) {
      if (anchor.section === section && anchor.paragraph >= from) anchor.paragraph += delta;
    }
  }
}
