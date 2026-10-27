// 끌어 옮기기·오른쪽 클릭 메뉴(SPEC-006 옮기기·지우기, #60): 본문 블록(문단·표) → 사람 편집(move_blocks·delete_blocks).
// 놓일 자리(쪽 위 가로선)와 메뉴 항목(지우기·위로·아래로)의 편집을 구한다. 거부 판정(구역 첫 문단 등)은 서버 몫이다.
import type { HwpDocument } from '@rhwp/core';
import { anchorsOf, type BlockAnchor } from './block-ids.ts';
import type { Block } from './block-schema.ts';
import { spotBox } from './edit-spot.ts';
import type { SelectionRect } from './highlight-rects.ts';
import { blockBoxes } from './highlight-targets.ts';
import type { UserEdit } from '../shared/protocol.ts';

/** 본문 블록 하나와 그 블록의 쪽별 사각형. 본문 블록 차례(문서 순서)로 놓는다 */
export interface BlockBand {
  anchor: BlockAnchor;
  boxes: SelectionRect[];
}

/** 본문 블록(문단·표)의 위치들, 문서 순서. 누름틀 블록은 문단 안이라 뺀다 */
function bodyAnchors(blocks: Block[]): Array<{ block: Block; anchor: BlockAnchor }> {
  const anchors = anchorsOf(blocks);
  return blocks.flatMap((block, index) => {
    const anchor = anchors[index];
    return block.kind !== 'field' && anchor !== undefined ? [{ block, anchor }] : [];
  });
}

/** 끌기를 시작할 때 한 번: 본문 블록마다 쪽별 사각형. 빈 문단은 커서 줄 자리 */
export function blockBands(doc: HwpDocument, blocks: Block[]): BlockBand[] {
  return bodyAnchors(blocks).map(({ block, anchor }) => {
    if (block.kind === 'paragraph' && block.text.length === 0) {
      const line = spotBox(doc, blocks, { anchor, text: '', caret: 0 });
      return { anchor, boxes: line === undefined ? [] : [line] };
    }
    return { anchor, boxes: blockBoxes(doc, blocks, [anchor]).boxes };
  });
}

const sameAnchor = (a: BlockAnchor, b: BlockAnchor) => a.section === b.section && a.paragraph === b.paragraph && a.part === b.part;

/** 놓일 자리: 보낼 편집과 쪽 위 가로선(높이 0, y 가 선 가운데) */
export interface DropSpot {
  edit: UserEdit;
  line: SelectionRect;
}

/**
 * 끄는 점(쪽, 쪽 위 y) → 놓일 자리. 그 쪽 블록들 중 점이 위 절반에 놓인 첫 블록 앞, 모두 지나면 그 쪽 마지막 블록 뒤.
 * 가로선은 앞뒤 블록 사이 가운데(쪽 첫·끝 블록이면 그 가장자리), 폭은 그 쪽 블록들의 가로 범위.
 * 놓아도 그대로인 자리(끄는 블록 바로 앞·뒤)와 블록이 없는 쪽은 undefined
 */
export function dropAt(bands: BlockBand[], dragged: BlockAnchor, pageIndex: number, y: number): DropSpot | undefined {
  const onPage = bands.flatMap((band, order) => {
    const box = band.boxes.find((candidate) => candidate.pageIndex === pageIndex);
    return box === undefined ? [] : [{ order, anchor: band.anchor, box }];
  });
  const last = onPage[onPage.length - 1];
  if (last === undefined) return undefined;
  const at = onPage.findIndex(({ box }) => y < box.y + box.height / 2);
  const target = onPage[at];
  // 본문 블록 차례에서 끼워 넣을 틈(gap 번째 블록 앞). 끄는 블록 바로 앞·뒤 틈이면 그대로다
  const gap = target === undefined ? last.order + 1 : target.order;
  const from = bands.findIndex((band) => sameAnchor(band.anchor, dragged));
  if (from === -1 || gap === from || gap === from + 1) return undefined;

  const left = Math.min(...onPage.map(({ box }) => box.x));
  const right = Math.max(...onPage.map(({ box }) => box.x + box.width));
  const above = onPage[at - 1];
  let lineY = last.box.y + last.box.height;
  if (target !== undefined) lineY = above === undefined ? target.box.y : (above.box.y + above.box.height + target.box.y) / 2;
  const line = { pageIndex, x: left, y: lineY, width: right - left, height: 0 };
  const edit: UserEdit =
    target === undefined
      ? { kind: 'move_blocks', blocks: [dragged], where: 'after', reference: last.anchor }
      : { kind: 'move_blocks', blocks: [dragged], where: 'before', reference: target.anchor };
  return { edit, line };
}

/** 오른쪽 클릭 메뉴 항목의 편집: 지우기, 위로(바로 앞 본문 블록 앞), 아래로(바로 뒤 본문 블록 뒤). 앞·뒤 블록이 없으면 그 항목은 없다 */
export interface MenuEdits {
  remove: UserEdit;
  up?: UserEdit;
  down?: UserEdit;
}

export function menuEdits(blocks: Block[], anchor: BlockAnchor): MenuEdits {
  const body = bodyAnchors(blocks);
  const at = body.findIndex((entry) => sameAnchor(entry.anchor, anchor));
  const before = at > 0 ? body[at - 1] : undefined;
  const after = at === -1 ? undefined : body[at + 1];
  return {
    remove: { kind: 'delete_blocks', targets: [anchor] },
    ...(before === undefined ? {} : { up: { kind: 'move_blocks', blocks: [anchor], where: 'before', reference: before.anchor } }),
    ...(after === undefined ? {} : { down: { kind: 'move_blocks', blocks: [anchor], where: 'after', reference: after.anchor } }),
  };
}
