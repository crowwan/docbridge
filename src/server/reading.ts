// 읽기 도구(get_outline·read_blocks)의 결과 만들기. 뷰어가 준 블록에 id 를 붙인 목록을 받아
// Claude 에게 보낼 JSON 으로 바꾸고, 정해진 크기를 넘으면 자르고 이어 받는 방법을 붙인다(UI 없는 순수 함수).
import type { Block, TableCell } from '../core/block-schema.ts';

/** get_outline 한 번에 보내는 블록 수 */
export const OUTLINE_LIMIT = 500;
/** read_blocks 한 번에 보내는 글자 수(문단 텍스트·칸 텍스트·누름틀 값) */
export const READ_CHAR_LIMIT = 20_000;
/** 개요에 보여주는 앞부분 글자 수 */
export const PREVIEW_CHARS = 40;

export interface LabeledBlock {
  id: string;
  block: Block;
}

export interface OutlineItem {
  id: string;
  kind: Block['kind'];
  page: number;
  /** 앞 40자. 더 길면 끝에 … */
  text: string;
  number?: string;
  outlineLevel?: number;
  /** 누름틀 이름 */
  name?: string;
}

/** 잘렸을 때 붙는 안내. next 는 다음에 같은 도구를 부를 인자 */
export interface More<Next> {
  message: string;
  next?: Next;
}

export interface OutlineResult {
  blockCount: number;
  blocks: OutlineItem[];
  more?: More<{ from: string }>;
}

export type ReadBlock =
  | { id: string; kind: 'paragraph'; page: number; text: string; number?: string; outlineLevel?: number; truncated?: true }
  | { id: string; kind: 'table'; page: number; rowCount: number; colCount: number; cells: TableCell[]; truncated?: true }
  | { id: string; kind: 'field'; page: number; name: string; guide: string; value: string; inTable: boolean; truncated?: true };

export type BlockSelection = { ids: string[] } | { fromPage: number; toPage: number; from?: string };

export interface ReadResult {
  blocks: ReadBlock[];
  more?: More<BlockSelection>;
}

const count = (value: number) => value.toLocaleString('en-US');

export const unknownIdsMessage = (ids: string[]) =>
  `없는 블록 id 입니다: ${ids.join(', ')}. get_outline 을 다시 불러 지금 블록 id 를 확인하세요.`;

function preview(text: string): string {
  const chars = [...text.replace(/\s*\n\s*/g, ' ')];
  return chars.length > PREVIEW_CHARS ? `${chars.slice(0, PREVIEW_CHARS).join('')}…` : chars.join('');
}

function outlineItem({ id, block }: LabeledBlock): OutlineItem {
  switch (block.kind) {
    case 'paragraph':
      return {
        id,
        kind: block.kind,
        page: block.page,
        text: preview(block.text),
        ...(block.number === undefined ? {} : { number: block.number }),
        ...(block.outlineLevel === undefined ? {} : { outlineLevel: block.outlineLevel }),
      };
    case 'table': {
      const cellTexts = block.cells.map((cell) => cell.text).filter((text) => text.trim().length > 0);
      return { id, kind: block.kind, page: block.page, text: preview(cellTexts.join(' | ')) };
    }
    case 'field':
      return { id, kind: block.kind, page: block.page, text: preview(block.value), name: block.name };
  }
}

function indexOfId(blocks: LabeledBlock[], id: string): number {
  const index = blocks.findIndex((labeled) => labeled.id === id);
  if (index === -1) throw new Error(unknownIdsMessage([id]));
  return index;
}

/** 문서 순서대로의 개요. from 이 있으면 그 블록부터. 500개를 넘으면 자른다 */
export function outline(blocks: LabeledBlock[], from?: string): OutlineResult {
  const start = from === undefined ? 0 : indexOfId(blocks, from);
  const end = Math.min(blocks.length, start + OUTLINE_LIMIT);
  const result: OutlineResult = { blockCount: blocks.length, blocks: blocks.slice(start, end).map(outlineItem) };
  const nextId = blocks[end]?.id;
  if (nextId === undefined) return result;
  return {
    ...result,
    more: {
      message: `블록이 ${count(blocks.length)}개라 ${start + 1}~${end}번째만 보냈습니다. 나머지는 get_outline 을 from: "${nextId}" 로 다시 부르세요.`,
      next: { from: nextId },
    },
  };
}

function readBlock({ id, block }: LabeledBlock): ReadBlock {
  switch (block.kind) {
    case 'paragraph': {
      const { kind, page, text, number, outlineLevel } = block;
      return {
        id,
        kind,
        page,
        text,
        ...(number === undefined ? {} : { number }),
        ...(outlineLevel === undefined ? {} : { outlineLevel }),
      };
    }
    case 'table': {
      const { kind, page, rowCount, colCount, cells } = block;
      return { id, kind, page, rowCount, colCount, cells };
    }
    case 'field': {
      const { kind, page, name, guide, value, inTable } = block;
      return { id, kind, page, name, guide, value, inTable };
    }
  }
}

/** 글자 수 한도에 세는 글자: 문단 텍스트, 칸 텍스트, 누름틀 값 */
function charCount(block: ReadBlock): number {
  switch (block.kind) {
    case 'paragraph':
      return block.text.length;
    case 'table':
      return block.cells.reduce((sum, cell) => sum + cell.text.length, 0);
    case 'field':
      return block.value.length;
  }
}

/** 혼자 한도를 넘는 블록을 한도 안으로 자른다. 표는 들어가는 칸까지(첫 칸이 넘으면 그 칸 글자를 자른다) */
function cutToLimit(block: ReadBlock, limit: number): ReadBlock {
  switch (block.kind) {
    case 'paragraph':
      return { ...block, text: block.text.slice(0, limit), truncated: true };
    case 'table': {
      const cells: TableCell[] = [];
      let used = 0;
      for (const cell of block.cells) {
        if (used + cell.text.length > limit) {
          if (cells.length === 0) cells.push({ ...cell, text: cell.text.slice(0, limit) });
          break;
        }
        cells.push(cell);
        used += cell.text.length;
      }
      return { ...block, cells, truncated: true };
    }
    case 'field':
      return { ...block, value: block.value.slice(0, limit), truncated: true };
  }
}

function selectBlocks(blocks: LabeledBlock[], selection: BlockSelection): LabeledBlock[] {
  if ('ids' in selection) {
    const byId = new Map(blocks.map((labeled) => [labeled.id, labeled]));
    const ids = [...new Set(selection.ids)];
    const unknown = ids.filter((id) => !byId.has(id));
    if (unknown.length > 0) throw new Error(unknownIdsMessage(unknown));
    return ids.flatMap((id) => byId.get(id) ?? []);
  }
  const start = selection.from === undefined ? 0 : indexOfId(blocks, selection.from);
  return blocks
    .slice(start)
    .filter(({ block }) => selection.fromPage <= block.page && block.page <= selection.toPage);
}

function nextSelection(selection: BlockSelection, rest: LabeledBlock[]): BlockSelection | undefined {
  const [first] = rest;
  if (first === undefined) return undefined;
  if ('ids' in selection) return { ids: rest.map(({ id }) => id) };
  return { fromPage: selection.fromPage, toPage: selection.toPage, from: first.id };
}

/** 고른 블록의 전문. 글자가 20,000자를 넘으면 넘기 전 블록까지(첫 블록이 혼자 넘으면 잘라서) 보낸다 */
export function readBlocks(blocks: LabeledBlock[], selection: BlockSelection): ReadResult {
  const selected = selectBlocks(blocks, selection);
  const sent: ReadBlock[] = [];
  let used = 0;
  let cut: { id: string; total: number; sentChars: number } | undefined;
  for (const labeled of selected) {
    const block = readBlock(labeled);
    const chars = charCount(block);
    if (used + chars <= READ_CHAR_LIMIT) {
      sent.push(block);
      used += chars;
      continue;
    }
    if (sent.length === 0) {
      const truncated = cutToLimit(block, READ_CHAR_LIMIT);
      sent.push(truncated);
      cut = { id: block.id, total: chars, sentChars: charCount(truncated) };
    }
    break;
  }
  const rest = selected.slice(sent.length);
  if (rest.length === 0 && cut === undefined) return { blocks: sent };
  const next = nextSelection(selection, rest);
  const message = [
    rest.length > 0 ? `글자가 ${count(READ_CHAR_LIMIT)}자를 넘어 블록 ${selected.length}개 중 ${sent.length}개만 보냈습니다.` : '',
    cut ? `${cut.id}: ${count(cut.total)}자 중 앞 ${count(cut.sentChars)}자만 보냈습니다.` : '',
    next ? '나머지는 read_blocks 를 more.next 의 인자로 다시 부르세요.' : '',
  ]
    .filter((part) => part.length > 0)
    .join(' ');
  return { blocks: sent, more: { message, ...(next ? { next } : {}) } };
}

export interface ReadBlocksArgs {
  ids?: string[] | undefined;
  fromPage?: number | undefined;
  toPage?: number | undefined;
  from?: string | undefined;
}

/** read_blocks 인자를 고르는 방법 하나(ids 또는 쪽 범위)로 바꾼다. toPage 가 없으면 fromPage 한 쪽 */
export function selectionFrom({ ids, fromPage, toPage, from }: ReadBlocksArgs): BlockSelection {
  if (ids !== undefined && (fromPage !== undefined || toPage !== undefined)) {
    throw new Error('ids 와 쪽 범위(fromPage·toPage) 중 하나만 주세요.');
  }
  if (ids !== undefined) return { ids };
  if (fromPage === undefined) throw new Error('읽을 블록을 ids 나 fromPage(·toPage) 로 정하세요.');
  return { fromPage, toPage: toPage ?? fromPage, ...(from === undefined ? {} : { from }) };
}
