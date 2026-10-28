// 넣은·옮긴 문단의 줄 배치(lineseg)가 들어간 문서의 본문 폭을 따르는지(#85).
// rhwp importParagraphBlock 은 원본 문서 폭으로 계산된 줄 배치를 그대로 가져온다 — 넓은 문서에서 한 줄이던 문단을
// 좁은 문서에 넣으면 한 줄로 남아 초록 표시·highlight·더블클릭 자리가 첫 줄 일부만 잡히고, 저장 파일에도 원본 폭이 남는다.
// copy_blocks(SPEC-007)·move_blocks(SPEC-002, importParagraphBlock + deleteParagraph)·insert_paragraph(SPEC-002) 를 같은 기준으로 본다.
// move_blocks 는 같은 문서 사본에서 가져와 폭이 같고, insert_paragraph 는 글자를 넣으며 다시 배치돼 고치기 전에도 맞았다(회귀 확인용).
import { HwpDocument } from '@rhwp/core';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { anchorsOf } from '../src/core/block-ids.ts';
import { extractBlocks } from '../src/core/blocks.ts';
import { copyParagraphs, type CopyResult } from '../src/core/copy-paragraphs.ts';
import { blockBoxes } from '../src/core/highlight-targets.ts';
import { linelessParagraphs, openHwpDocument } from '../src/core/open-document.ts';
import { insertParagraphNear, moveParagraphs } from '../src/core/edits.ts';
import { parseJson } from '../src/core/json.ts';
import { createBlankDocument } from '../src/core/rhwp-node.ts';
import { buildCopySource, SRC } from './copy-source.ts';
import { fixturePath } from './fixtures.ts';
import { rhwpViewer } from './rhwp-viewer.ts';

const S = 0;
const lineInfoSchema = z.object({ lineCount: z.number() });
const rectsSchema = z.array(z.object({ pageIndex: z.number(), x: z.number(), y: z.number(), width: z.number(), height: z.number() }));

const lineCount = (doc: HwpDocument, paragraph: number) => parseJson(lineInfoSchema, doc.getLineInfo(S, paragraph, 0)).lineCount;
const paragraphRects = (doc: HwpDocument, paragraph: number) =>
  parseJson(rectsSchema, doc.getSelectionRects(S, paragraph, 0, paragraph, doc.getParagraphLength(S, paragraph)));
/** HWPX 로 저장해 다시 연 문서 */
const reopened = (doc: HwpDocument) => new HwpDocument(doc.exportHwpx());

const warningsSchema = z.object({ warnings: z.array(z.object({ section: z.number(), paragraph: z.number(), kind: z.string(), cell: z.unknown() })) });

/**
 * 저장 파일에 남은 그 문단의 줄 배치: 'recompute' = 줄 배치를 쓰지 않아 한글이 열 때 다시 계산한다, 아니면 저장된 줄 수.
 * rhwp 는 다시 배치한 줄 배치를 저장하거나, 자기가 합성한 줄 배치라 판단하면 linesegarray 를 빼고 저장한다(#1380 — 어느 쪽인지는 문서마다 다르다).
 * 어느 쪽이든 원본 폭 줄 배치(한 줄)가 그대로 저장되지는 않아야 한다
 */
function savedLayout(saved: HwpDocument, paragraph: number): number | 'recompute' {
  const { warnings } = parseJson(warningsSchema, saved.getValidationWarnings());
  const empty = warnings.some((w) => w.section === S && w.paragraph === paragraph && w.cell === null && w.kind === 'LinesegArrayEmpty');
  return empty ? 'recompute' : lineCount(saved, paragraph);
}

const textOf = (doc: HwpDocument, paragraph: number) => doc.getTextRange(S, paragraph, 0, doc.getParagraphLength(S, paragraph));

/**
 * 넓은 원본(기본 본문 폭 42520): SRC.sourceStyle 문단 앞에 글자를 더해 원본에서는 한 줄, 좁은 대상에서는 여러 줄이 되게 한다.
 * 원본에만 있는 스타일("강조 문단") 문단이라 복사 보정(applyStyle — 그 문단을 다시 배치한다)을 거치지 않는다
 */
function wideSource(): HwpDocument {
  const source = buildCopySource();
  source.insertText(S, SRC.sourceStyle, 0, '넓은 문서에서 한 줄인 ');
  return source;
}

/** 본문 글자 크기(10pt)로 좁은 대상에서 여러 줄, 넓은 문서에서 한 줄인 글자 */
const LONG_TEXT = '본문 글자 크기로 좁은 문서에서는 여러 줄로 감기는 문단';

/**
 * 본문 폭이 좁은 대상(좌우 여백 20000 → 본문 19528, 기본의 절반쯤). 문단 셋: "좁은 안내문" / "본문 문단" / "끝."
 * rhwp 0.8.7 은 setPageDef 로 용지를 바꾼 뒤 계산한 줄 배치를 HWPX 에 쓰지 않는다(빈 채로 내보내 한글이 다시 계산하게 둔다).
 * 그래서 용지를 바꾼 문서를 두 번 저장·다시 열어, 그 뒤 편집으로 생기는 줄 배치(넣은·옮긴 문단)는 실제 문서처럼 저장되게 한다.
 * 대상 자신의 문단 셋은 줄 배치 없이 저장돼 보지 않는다
 */
function narrowTarget(): HwpDocument {
  const blank = createBlankDocument();
  blank.setPageDef(S, JSON.stringify({ marginLeft: 20000, marginRight: 20000 }));
  const paged = new HwpDocument(blank.exportHwpx());
  blank.free();
  ['좁은 안내문', '본문 문단', '끝.'].forEach((text, i) => {
    if (i > 0) paged.splitParagraph(S, i - 1, paged.getParagraphLength(S, i - 1));
    paged.insertText(S, i, 0, text);
  });
  const doc = new HwpDocument(paged.exportHwpx());
  paged.free();
  return doc;
}

function copied(result: CopyResult) {
  if (!result.ok) throw new Error(`복사가 거부됐다: ${JSON.stringify(result.rejected)}`);
  return result;
}

describe('SPEC-007 · SPEC-002 넣은·옮긴 문단의 줄 배치는 대상 본문 폭을 따른다 (#85)', () => {
  it('copy_blocks 로 좁은 문서에 넣은 한 줄 문단은 대상 폭으로 여러 줄이 되고, 줄마다 사각형이 하나씩이다', () => {
    const source = wideSource();
    expect(lineCount(source, SRC.sourceStyle)).toBe(1);
    const target = narrowTarget();

    copied(copyParagraphs(target, source.exportHwpx(), { section: S, start: SRC.sourceStyle, end: SRC.sourceStyle + 1 }, { section: S, before: 2 }));

    const lines = lineCount(target, 2);
    expect(lines).toBeGreaterThan(1);
    const rects = paragraphRects(target, 2);
    expect(rects).toHaveLength(lines);
    // 줄마다 다른 높이 — 첫 줄 일부만 덮는 사각형 하나가 아니다
    expect(new Set(rects.map(({ y }) => y)).size).toBe(lines);
  });

  it('copy_blocks 로 넣은 문단은 저장한 HWPX 에 원본 폭 줄 배치가 남지 않는다(대상 폭 줄 배치 또는 한글이 다시 계산)', () => {
    const source = wideSource();
    const target = narrowTarget();
    copied(copyParagraphs(target, source.exportHwpx(), { section: S, start: SRC.sourceStyle, end: SRC.sourceStyle + 1 }, { section: S, before: 2 }));
    const lines = lineCount(target, 2);

    const saved = reopened(target);

    expect(textOf(saved, 2)).toBe(textOf(source, SRC.sourceStyle));
    expect(lines).toBeGreaterThan(1);
    // 이 문서에서 rhwp 는 다시 배치한 줄 배치를 합성한 것으로 보고 빼고 저장한다(원본 폭 한 줄이 저장되면 1)
    expect(savedLayout(saved, 2)).toBe('recompute');
  });

  it('move_blocks 로 옮긴 문단은 옮기기 전과 줄 수가 같고, 저장한 HWPX 에도 그 줄 배치(또는 한글이 다시 계산)가 남는다', () => {
    const doc = narrowTarget();
    doc.insertText(S, 1, 0, `${LONG_TEXT} `);
    const lines = lineCount(doc, 1);
    expect(lines).toBeGreaterThan(1);

    const result = moveParagraphs(doc, S, 1, 2, 3);

    expect(result).toEqual({ ok: true, moved: { start: 2, end: 3 } });
    expect(lineCount(doc, 2)).toBe(lines);
    expect([lines, 'recompute']).toContain(savedLayout(reopened(doc), 2));
  });

  it('insert_paragraph 로 넣은 문단은 대상 폭의 여러 줄이고, 저장해 다시 열어도 같다', () => {
    const doc = narrowTarget();

    const at = insertParagraphNear(doc, S, 1, 'after', LONG_TEXT);

    const lines = lineCount(doc, at);
    expect(lines).toBeGreaterThan(1);
    expect(paragraphRects(doc, at)).toHaveLength(lines);
    expect(savedLayout(reopened(doc), at)).toBe(lines);
  });
});

/** 좁은 문서에 넓은 원본의 한 줄 문단을 copy_blocks 로 넣고(대상 문단 2) HWPX 로 저장한 바이트 — 넣은 문단은 줄 배치 없이 저장된다 */
function savedNarrowCopy(): Uint8Array {
  const source = wideSource();
  const target = narrowTarget();
  copied(copyParagraphs(target, source.exportHwpx(), { section: S, start: SRC.sourceStyle, end: SRC.sourceStyle + 1 }, { section: S, before: 2 }));
  const bytes = target.exportHwpx();
  source.free();
  target.free();
  return bytes;
}

const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');

describe('SPEC-007 줄 배치가 빠진 채 저장된 문단은 다시 열면 줄마다 잡힌다 (#89)', () => {
  it('좁은 문서에 복사해 저장한 파일을 다시 열면(load_document) 넣은 문단의 줄 사각형이 여러 줄이다', () => {
    const bytes = savedNarrowCopy();
    // rhwp 로 그냥 열면 한 줄(고치기 전 docbridge 와 같다)
    expect(lineCount(new HwpDocument(bytes), 2)).toBe(1);
    const viewer = rhwpViewer();

    viewer.handle({ type: 'request', id: 1, method: 'load_document', params: { doc: 'd1', fileName: '좁은 문서.hwpx', data: base64(bytes) } });

    const { doc } = viewer.editor();
    const lines = lineCount(doc, 2);
    expect(lines).toBeGreaterThan(1);
    const rects = paragraphRects(doc, 2);
    expect(rects).toHaveLength(lines);
    expect(new Set(rects.map(({ y }) => y)).size).toBe(lines);
  });

  it('그 파일을 양식으로 새 문서를 만들어도(create_document 내용 그대로) 넣은 문단이 여러 줄이다', () => {
    const bytes = savedNarrowCopy();
    const viewer = rhwpViewer();

    viewer.handle({
      type: 'request',
      id: 1,
      method: 'create_document',
      params: { doc: 'd1', fileName: '새 문서.hwpx', template: { fileName: '좁은 문서.hwpx', data: base64(bytes), keepContent: true } },
    });

    const { doc } = viewer.editor();
    expect(lineCount(doc, 2)).toBeGreaterThan(1);
    expect(paragraphRects(doc, 2)).toHaveLength(lineCount(doc, 2));
  });

  it('저장 파일에서 넣은 문단은 줄 배치가 빠진 본문 문단으로 잡힌다(다시 배치할 대상)', () => {
    expect(linelessParagraphs(new HwpDocument(savedNarrowCopy()))).toContainEqual({ section: S, paragraph: 2 });
  });
});

const FIXTURES = ['notice.hwpx', 'notice.hwp', 'application.hwpx', 'outline-demo.hwpx', 'report.hwpx'];
const blockBoxesOf = (doc: HwpDocument) => {
  const blocks = extractBlocks(doc);
  return blockBoxes(doc, blocks, anchorsOf(blocks));
};

describe('SPEC-007 열 때 다시 배치는 줄 배치가 있는 일반 문서를 바꾸지 않는다 (#89)', () => {
  it.each(FIXTURES)('%s: 블록·블록 사각형(하이라이트·바뀐 블록 표시)·HWPX 저장 결과가 그냥 연 것과 같다', (name) => {
    const bytes = new Uint8Array(readFileSync(fixturePath(name)));
    const plain = new HwpDocument(bytes);
    const opened = openHwpDocument(bytes);

    expect(extractBlocks(opened)).toEqual(extractBlocks(plain));
    expect(blockBoxesOf(opened)).toEqual(blockBoxesOf(plain));
    expect(opened.exportHwpx()).toEqual(plain.exportHwpx());
    expect(opened.pageCount()).toBe(plain.pageCount());
  });

  it('구역 첫 문단을 먼저 다시 배치하지 않고 reflowLinesegs() 만 부르면 저장 결과가 바뀐다(뒤 문단 vertpos 가 한 줄씩 밀림)', () => {
    // openHwpDocument 가 구역 첫 문단을 먼저 다시 배치하는 이유. rhwp 를 올려 이 테스트가 실패하면 그 단계를 빼는 것을 다시 본다
    const bytes = new Uint8Array(readFileSync(fixturePath('notice.hwpx')));
    const plain = new HwpDocument(bytes);
    const reflowed = new HwpDocument(bytes);

    expect(reflowed.reflowLinesegs()).toBeGreaterThan(0);

    expect(reflowed.exportHwpx()).not.toEqual(plain.exportHwpx());
  });
});
