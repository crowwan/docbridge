// 읽기 도구: 뷰어에 블록·찾기를 요청하고(session.requestViewer), 서버의 id 표로 블록 위치에 id 를 붙인다.
import type { Block } from '../core/block-schema.ts';
import type { BlockIdTable } from '../core/block-ids.ts';
import { outline, readBlocks, type BlockSelection, type LabeledBlock, type OutlineResult, type ReadResult } from './reading.ts';
import { NO_DOCUMENT, type DocumentSession } from './session.ts';

export interface FoundText {
  id: string;
  /** 표 칸 안 일치면 칸 좌표(0부터) */
  row?: number;
  col?: number;
  /** 블록(표는 칸) 텍스트 안 글자 위치. 끝은 포함하지 않는다 */
  start: number;
  end: number;
  before: string;
  after: string;
}

export interface FindResult {
  query: string;
  matchCount: number;
  matches: FoundText[];
}

/** 뷰어 응답을 받은 뒤의 id 표. 그사이 문서가 닫혔으면 문서 없음 */
function idTable(session: DocumentSession): BlockIdTable {
  const document = session.document;
  if (document === undefined) throw new Error(NO_DOCUMENT);
  return document.ids;
}

async function labeledBlocks(session: DocumentSession): Promise<LabeledBlock[]> {
  const blocks: Block[] = await session.requestViewer('get_blocks', {});
  return idTable(session)
    .label(blocks)
    .flatMap(({ id, block }) => (id === undefined ? [] : [{ id, block }]));
}

export async function getOutline(session: DocumentSession, from?: string): Promise<OutlineResult> {
  return outline(await labeledBlocks(session), from);
}

export async function readBlockContents(session: DocumentSession, selection: BlockSelection): Promise<ReadResult> {
  return readBlocks(await labeledBlocks(session), selection);
}

export async function findText(session: DocumentSession, query: string): Promise<FindResult> {
  const found = await session.requestViewer('find_text', { query });
  const ids = idTable(session);
  const matches = found.flatMap(({ block, row, col, start, end, before, after }): FoundText[] => {
    const id = ids.idOf(block);
    if (id === undefined) return [];
    return [{ id, ...(row === undefined ? {} : { row }), ...(col === undefined ? {} : { col }), start, end, before, after }];
  });
  return { query, matchCount: matches.length, matches };
}
