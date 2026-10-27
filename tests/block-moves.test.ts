import { describe, expect, it } from 'vitest';
import { anchorsOf, type BlockAnchor } from '../src/core/block-ids.ts';
import { blockBands, dropAt, menuEdits, type BlockBand } from '../src/core/block-moves.ts';
import { extractBlocks } from '../src/core/blocks.ts';
import { bodyBlockAt } from '../src/core/edit-spot.ts';
import type { SelectionRect } from '../src/core/highlight-rects.ts';
import { blockBoxes } from '../src/core/highlight-targets.ts';
import { openFixture } from './fixtures.ts';

// notice.hwpx: b1~b14 = 블록 순서. b3 은 b2 문단 안 누름틀, b12 는 표
const doc = openFixture('notice.hwpx');
const blocks = extractBlocks(doc);
const anchors = anchorsOf(blocks);

function anchorOf(id: string): BlockAnchor {
  const anchor = anchors[Number(id.slice(1)) - 1];
  if (anchor === undefined) throw new Error(`${id} 가 없다`);
  return anchor;
}

function boxOf(id: string): SelectionRect {
  const [box] = blockBoxes(doc, blocks, [anchorOf(id)]).boxes;
  if (box === undefined) throw new Error(`${id} 자리가 없다`);
  return box;
}

const centerOf = (rect: SelectionRect) => ({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });

describe('SPEC-006 점 → 본문 블록(끌어 옮기기·오른쪽 클릭 대상)', () => {
  it('문단 글자 위를 고르면 그 문단 블록과 이 쪽 사각형을 준다', () => {
    expect(bodyBlockAt(doc, blocks, 0, centerOf(boxOf('b11')))).toEqual({ anchor: anchorOf('b11'), box: boxOf('b11') });
  });

  it('표 칸 위는 표 블록째, 누름틀 값 위는 그 문단 블록이다', () => {
    expect(bodyBlockAt(doc, blocks, 0, centerOf(boxOf('b12')))?.anchor).toEqual(anchorOf('b12'));
    expect(bodyBlockAt(doc, blocks, 0, centerOf(boxOf('b3')))?.anchor).toEqual(anchorOf('b2'));
  });

  it('블록 밖(마지막 문단 아래 빈 곳)은 고르지 않는다', () => {
    const last = boxOf('b14');
    expect(bodyBlockAt(doc, blocks, 0, { x: last.x + 10, y: last.y + last.height + 200 })).toBeUndefined();
  });
});

describe('SPEC-006 오른쪽 클릭 메뉴 — 지우기·위로·아래로', () => {
  it('지우기는 그 블록 delete_blocks, 위로는 바로 앞 블록 앞, 아래로는 바로 뒤 블록 뒤 move_blocks 다', () => {
    expect(menuEdits(blocks, anchorOf('b11'))).toEqual({
      remove: { kind: 'delete_blocks', targets: [anchorOf('b11')] },
      up: { kind: 'move_blocks', blocks: [anchorOf('b11')], where: 'before', reference: anchorOf('b10') },
      down: { kind: 'move_blocks', blocks: [anchorOf('b11')], where: 'after', reference: anchorOf('b12') },
    });
  });

  it('앞·뒤 블록은 누름틀을 건너뛴 본문 블록(문단·표)이다', () => {
    expect(menuEdits(blocks, anchorOf('b4')).up).toMatchObject({ reference: anchorOf('b2') });
    expect(menuEdits(blocks, anchorOf('b2')).down).toMatchObject({ reference: anchorOf('b4') });
  });

  it('첫 블록은 위로, 마지막 블록은 아래로가 없다', () => {
    expect(menuEdits(blocks, anchorOf('b1')).up).toBeUndefined();
    expect(menuEdits(blocks, anchorOf('b14')).down).toBeUndefined();
  });
});

describe('SPEC-006 끌어 옮기기 — 놓일 자리와 가로선', () => {
  const anchor = (paragraph: number): BlockAnchor => ({ section: 0, paragraph, part: 'text' });
  const band = (paragraph: number, pageIndex: number, y: number): BlockBand => ({
    anchor: anchor(paragraph),
    boxes: [{ pageIndex, x: 100 + paragraph, y, width: 200 - paragraph, height: 10 }],
  });
  // 1쪽 A(0~10)·B(20~30)·C(40~50), 2쪽 D(0~10)
  const bands = [band(0, 0, 0), band(1, 0, 20), band(2, 0, 40), band(3, 1, 0)];

  it('블록 위 절반이면 그 블록 앞, 가로선은 앞 블록과의 사이 가운데이고 폭은 그 쪽 블록들의 가로 범위다', () => {
    expect(dropAt(bands, anchor(0), 0, 26)).toEqual({
      edit: { kind: 'move_blocks', blocks: [anchor(0)], where: 'before', reference: anchor(2) },
      line: { pageIndex: 0, x: 100, y: 35, width: 200, height: 0 },
    });
  });

  it('쪽 첫 블록 앞은 그 블록 위 가장자리, 쪽 블록을 모두 지나면 마지막 블록 뒤(아래 가장자리)다', () => {
    expect(dropAt(bands, anchor(2), 0, 3)).toMatchObject({ edit: { where: 'before', reference: anchor(0) }, line: { y: 0 } });
    expect(dropAt(bands, anchor(0), 0, 300)).toMatchObject({ edit: { where: 'after', reference: anchor(2) }, line: { y: 50 } });
  });

  it('다른 쪽에 놓으면 그 쪽 블록 기준이다', () => {
    expect(dropAt(bands, anchor(0), 1, 2)).toMatchObject({ edit: { where: 'before', reference: anchor(3) }, line: { pageIndex: 1, y: 0 } });
  });

  it('놓아도 그대로인 자리(끄는 블록 바로 앞·뒤)와 블록이 없는 쪽은 놓일 자리가 없다', () => {
    expect(dropAt(bands, anchor(0), 0, 15)).toBeUndefined();
    expect(dropAt(bands, anchor(0), 0, 3)).toBeUndefined();
    expect(dropAt(bands, anchor(2), 0, 42)).toBeUndefined();
    expect(dropAt(bands, anchor(2), 0, 300)).toBeUndefined();
    expect(dropAt(bands, anchor(0), 2, 0)).toBeUndefined();
  });

  it('실문서에서 본문 블록마다 사각형을 구한다(누름틀은 빼고 표는 넣는다)', () => {
    const real = blockBands(doc, blocks);
    expect(real.map(({ anchor: { paragraph, part } }) => `${paragraph}:${part}`)).toEqual(
      ['b1', 'b2', 'b4', 'b5', 'b6', 'b7', 'b8', 'b9', 'b10', 'b11', 'b12', 'b13', 'b14'].map((id) => `${anchorOf(id).paragraph}:${anchorOf(id).part}`),
    );
    expect(real.every(({ boxes }) => boxes.length > 0)).toBe(true);
  });
});
