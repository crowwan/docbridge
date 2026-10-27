// delete_blocks(SPEC-002 AC-3): 블록(문단·표)을 지운다. 뷰어(document-editor.ts → edit-operations.ts)에서 돈다.
// 무엇을 지울지는 뷰어가 지금 문서(블록·누름틀 위치·컨트롤 종류)로 정하고, 실제로 지운 문단·표를 ParagraphChanges 로 돌려준다.
// 서버는 그것으로 id 표를 옮긴다 — 서버가 따로 계획하지 않는다(PR #29 리뷰). 서버는 assertDeletable 로 미리 거부만 한다.
import type { HwpDocument } from '@rhwp/core';
import { z } from 'zod';
import { anchorsOf, blockIndexByAnchor, fieldOrdinal, tableControlIndex, type BlockAnchor } from './block-ids.ts';
import type { Block } from './block-schema.ts';
import { bodyControlsAt, type BodyControl } from './body-paragraphs.ts';
import { fieldTableIndex, listFields, type FieldInfo } from './fields.ts';
import { parseJson } from './json.ts';
import { noParagraphChanges, positionKey, type ParagraphChanges, type ParagraphPosition } from './paragraph-changes.ts';

export interface DeleteTarget {
  id: string;
  anchor: BlockAnchor;
}

const FIRST_PARAGRAPH = 0;

/**
 * 블록 위치만 보고 거부할 것: 누름틀 블록, 구역 첫 문단(구역·단 정의가 든다 — rhwp 는 지우면 정의도 같이 지운다).
 * 첫 문단을 지우지 않으므로 구역이 비는 삭제(rhwp 가 거부)도 생기지 않는다. 서버가 뷰어에 보내기 전에, 뷰어가 지우기 전에 부른다
 */
export function assertDeletable(targets: DeleteTarget[]): void {
  const fields = targets.filter(({ anchor }) => fieldOrdinal(anchor) !== undefined).map(({ id }) => id);
  if (fields.length > 0) {
    throw new Error(
      `누름틀 블록은 지울 수 없습니다: ${fields.join(', ')}. 값을 비우려면 replace_text 를, 문단째 지우려면 그 문단 블록 id 를 주세요.`,
    );
  }
  const firsts = targets.filter(({ anchor }) => anchor.part === 'text' && anchor.paragraph === FIRST_PARAGRAPH).map(({ id }) => id);
  if (firsts.length > 0) {
    throw new Error(`구역 첫 문단은 지울 수 없습니다(구역·단 정의가 든 문단): ${firsts.join(', ')}. 글자를 지우려면 replace_text 를 쓰세요.`);
  }
}

// 문단째 지워도 잃는 것이 없는(문단 글자와 같이 사라지는) 보이지 않는 인라인 컨트롤. 이 밖의 블록이 아닌 개체
// (구역·단 정의, 머리말·꼬리말, 각주·미주, 그림·도형, 수식, 쪽 번호 위치, 감추기 등)가 든 문단은 지우지 않는다(조용히 같이 사라진다)
const INLINE_CONTROLS = new Set(['bokm', 'nwno', 'atno', 'idxm']);
const isInlineControl = (ctrlId: string) => ctrlId === '' || ctrlId.startsWith('%') || INLINE_CONTROLS.has(ctrlId);
const TABLE_CONTROL = 'tbl';

const controlPositionsSchema = z.array(z.number());
const SECTION_DEFINITION = 'secd';

type ControlSource = Pick<HwpDocument, 'getControls' | 'getControlTextPositions' | 'getParagraphCount' | 'getSectionCount'>;

/**
 * 본문 문단의 컨트롤 목록. getControls 의 본문(목록 0) para 는 문서 전체 문단 번호라 bodyControlsAt 으로 (구역, 문단)에 맞춘다(#41).
 * 맞춰 보지 못하면 undefined: 구역마다 첫 문단에 구역 정의가 없으면(문단 번호 맞추기가 어긋남) 모든 문단,
 * 문단 컨트롤 수가 getControlTextPositions 와 다르면 그 문단
 */
export function bodyControls(doc: ControlSource): (position: ParagraphPosition) => BodyControl[] | undefined {
  const byParagraph = bodyControlsAt(doc);
  const aligned = Array.from({ length: doc.getSectionCount() }, (_, section) =>
    byParagraph.get(positionKey({ section, paragraph: FIRST_PARAGRAPH }))?.some(({ ctrlId }) => ctrlId === SECTION_DEFINITION),
  ).every(Boolean);
  return (position) => {
    if (!aligned) return undefined;
    const here = byParagraph.get(positionKey(position)) ?? [];
    const positions = parseJson(controlPositionsSchema, doc.getControlTextPositions(position.section, position.paragraph));
    return here.length === positions.length ? here : undefined;
  };
}

/** 누름틀 블록 위치 → 그 누름틀이 든 표의 컨트롤 번호(문단 직속·글상자 안이면 undefined). 블록 추출이 getFieldList 순서를 따른다 */
function fieldTableOf(fields: FieldInfo[]): (anchor: BlockAnchor) => number | undefined {
  return (anchor) => {
    const ordinal = fieldOrdinal(anchor);
    if (ordinal === undefined) return undefined;
    const field = fields.filter(
      ({ location }) => location.sectionIndex === anchor.section && location.paraIndex === anchor.paragraph,
    )[ordinal];
    return fieldTableIndex(field?.location.path);
  };
}

/**
 * 블록(문단·표)을 지우고 실제로 지운 문단·표를 돌려준다. 여러 블록도 편집 하나(스냅샷 하나)다.
 * - 문단 블록은 문단째(든 표·누름틀도 같이)
 * - 표 블록은 그 문단에 다른 블록(문단 글자·다른 표·표 밖 누름틀)이 없으면 문단째(빈 줄이 남지 않게), 있으면 표만.
 *   지우는 표 안 누름틀은 표와 같이 사라지므로 "다른 블록"으로 세지 않는다
 * - 문단째 지울 문단에 블록이 아닌 개체(머리말·각주·그림·수식 등)가 있으면 거부한다
 * - 누름틀이 든 문단(표 안·표 밖)에서 표만 지우는 것은 거부한다(rhwp 가 같은 문단 누름틀을 잃는다)
 */
export function deleteBlocks(doc: HwpDocument, blocks: Block[], targets: DeleteTarget[]): ParagraphChanges {
  const indexOf = blockIndexByAnchor(blocks);
  for (const { id, anchor } of targets) {
    if (indexOf(anchor) === undefined) throw new Error(`${id}: 뷰어 문서에 이 블록이 없습니다. get_outline 을 다시 부르세요.`);
  }
  assertDeletable(targets);
  const anchorsByParagraph = new Map<string, BlockAnchor[]>();
  for (const anchor of anchorsOf(blocks)) {
    const key = positionKey(anchor);
    anchorsByParagraph.set(key, [...(anchorsByParagraph.get(key) ?? []), anchor]);
  }
  const targetsByParagraph = new Map<string, DeleteTarget[]>();
  for (const target of targets) {
    const key = positionKey(target.anchor);
    targetsByParagraph.set(key, [...(targetsByParagraph.get(key) ?? []), target]);
  }
  const fieldTable = fieldTableOf(listFields(doc));
  const controlsAt = bodyControls(doc);
  const changes = noParagraphChanges();

  for (const [key, here] of targetsByParagraph) {
    const [first] = here;
    if (first === undefined) continue;
    const position = { section: first.anchor.section, paragraph: first.anchor.paragraph };
    const parts = new Set(here.map(({ anchor }) => anchor.part));
    const tables = new Set(here.flatMap(({ anchor }) => tableControlIndex(anchor) ?? []));
    const inTargetedTable = (anchor: BlockAnchor) => {
      const table = fieldTable(anchor);
      return table !== undefined && tables.has(table);
    };
    const others = (anchorsByParagraph.get(key) ?? []).filter((anchor) => !parts.has(anchor.part) && !inTargetedTable(anchor));
    const whole = parts.has('text') || (others.length === 0 && position.paragraph !== FIRST_PARAGRAPH);
    if (whole) {
      assertNoHiddenObjects(controlsAt(position), first.id);
      changes.deletedParagraphs.push(position);
      continue;
    }
    for (const target of here) {
      const controlIndex = tableControlIndex(target.anchor);
      if (controlIndex === undefined) continue;
      // rhwp deleteTableControl 은 같은 문단의 누름틀을 누름틀 목록에서 잃는다(다시 열어도 없다, PR #29 리뷰에서 확인)
      const withField = (anchorsByParagraph.get(key) ?? []).some((anchor) => fieldOrdinal(anchor) !== undefined);
      if (withField) throw new Error(tableWithFieldMessage(target.id, position, others));
      changes.deletedTables.push({ ...position, controlIndex });
    }
  }

  const order = (a: ParagraphPosition, b: ParagraphPosition) => a.section - b.section || a.paragraph - b.paragraph;
  changes.deletedParagraphs.sort(order);
  changes.deletedTables.sort((a, b) => order(a, b) || a.controlIndex - b.controlIndex);
  // 같은 문단 표는 컨트롤 번호 큰 것부터, 문단은 뒤에서부터 지워 앞 번호가 밀리지 않게 한다
  for (const table of [...changes.deletedTables].reverse()) doc.deleteTableControl(table.section, table.paragraph, table.controlIndex);
  for (const position of [...changes.deletedParagraphs].reverse()) doc.deleteParagraph(position.section, position.paragraph);
  return changes;
}

function assertNoHiddenObjects(controls: BodyControl[] | undefined, id: string): void {
  if (controls === undefined) throw new Error(`${id}: 문단에 든 개체를 확인하지 못해 지울 수 없습니다.`);
  const hidden = controls.filter(({ ctrlId }) => ctrlId !== TABLE_CONTROL && !isInlineControl(ctrlId));
  if (hidden.length > 0) {
    const names = [...new Set(hidden.map(({ userDesc, ctrlId }) => userDesc || ctrlId))];
    throw new Error(`${id}: 문단에 블록이 아닌 개체(${names.join(', ')})가 있어 같이 사라지므로 지울 수 없습니다.`);
  }
}

/** 누름틀이 든 문단에서 표만 지울 수 없을 때: 문단째 지울 길이 있으면 그 방법을, 없으면 지울 수 없다고 분명히 알린다 */
function tableWithFieldMessage(id: string, position: ParagraphPosition, others: BlockAnchor[]): string {
  const head = `${id}: 누름틀이 든 문단에서는 표만 지울 수 없습니다(표만 지우면 누름틀이 망가집니다).`;
  if (position.paragraph === FIRST_PARAGRAPH) return `${head} 구역 첫 문단이라 문단째 지울 수도 없으므로 이 표는 지울 수 없습니다.`;
  if (others.some((anchor) => anchor.part === 'text')) return `${head} 문단째 지우려면 표가 든 문단의 문단 블록 id 를 같이 주세요.`;
  if (others.some((anchor) => fieldOrdinal(anchor) !== undefined)) {
    return `${head} 표 밖에 누름틀이 있는 문단이라 문단째 지울 수도 없으므로 이 표는 지울 수 없습니다.`;
  }
  return `${head} 문단째 지우려면 같은 문단의 다른 표도 같이 주세요.`;
}
