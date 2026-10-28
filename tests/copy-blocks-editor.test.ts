// SPEC-007 copy_blocks 의 원본 범위 계획(server/move-plan.ts planCopySource)과 대상 탭 편집(core/edit-operations.ts copy_blocks).
// 대상 탭은 편집 공용 경로(core/document-editor.ts)로 넣는다 — 스냅샷 하나, 실패하면 되돌림, 넣은 문단의 블록마다 새 id 자리.
import type { HwpDocument } from '@rhwp/core';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { BlockIdTable } from '../src/core/block-ids.ts';
import { extractBlocks, type Block } from '../src/core/blocks.ts';
import { DocumentEditor } from '../src/core/document-editor.ts';
import type { EditOperation } from '../src/core/edit-operations.ts';
import { parseJson } from '../src/core/json.ts';
import { createBlankDocument } from '../src/core/rhwp-node.ts';
import { bytesToBase64 } from '../src/shared/base64.ts';
import { planCopySource } from '../src/server/move-plan.ts';
import { buildCopySource, SOURCE_ONLY_STYLE } from './copy-source.ts';
import { openFixture } from './fixtures.ts';

const S = 0;
const styleNames = (doc: HwpDocument) => parseJson(z.array(z.object({ name: z.string() })), doc.getStyleList()).map(({ name }) => name);
/** 문단 블록은 "번호 글자", 표는 칸 글자, 누름틀은 이름 */
const outlineOf = (blocks: Block[]) =>
  blocks.map((b) => {
    if (b.kind === 'paragraph') return b.number === undefined ? b.text : `${b.number} ${b.text}`;
    if (b.kind === 'table') return `표 ${b.cells.map((c) => c.text).join('|')}`;
    return `누름틀 ${b.name}`;
  });

/** 원본 문서 하나: 원본 탭이 보낼 HWPX 바이트와 원본 id 표 */
function sourceOf(doc: HwpDocument) {
  return { doc, data: bytesToBase64(doc.exportHwpx()), ids: BlockIdTable.assign(extractBlocks(doc)) };
}

/** 서버와 같은 방법(planCopySource + 대상 id 표)으로 copy_blocks 편집을 만든다 */
function copyOperation(
  source: ReturnType<typeof sourceOf>,
  ids: string[],
  target: DocumentEditor,
  referenceId: string,
  where: 'before' | 'after',
): EditOperation {
  const { section, start, end, blocks } = planCopySource(source.ids, ids);
  const anchor = BlockIdTable.assign(target.blocks).anchor(referenceId);
  if (anchor === undefined) throw new Error(`대상에 ${referenceId} 가 없다`);
  return { kind: 'copy_blocks', source: { data: source.data, section, start, end, blocks }, reference: { id: referenceId, anchor }, where };
}

// notice.hwpx: b2(문단 1)·b3(문단 1 누름틀 "수신"), b4(문단 2), b5(문단 3), 문단 4 는 빈 문단, b6~b11(문단 5~10, 번호 1. 2. 가. 나. 다. 3.), b12 표(문단 11)
const idRange = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => `b${from + i}`);
describe('SPEC-007 copy_blocks — 원본 범위 계획 (planCopySource, move_blocks 와 같은 범위 규칙)', () => {
  const ids = () => BlockIdTable.assign(extractBlocks(openFixture('notice.hwpx')));
  const anchor = (paragraph: number, part = 'text') => ({ section: 0, paragraph, part });

  it('고른 블록이 든 이어진 문단 범위와 그 안 블록 모두(같은 문단 누름틀·사이 빈 문단 포함)', () => {
    expect(planCopySource(ids(), ['b5', 'b6'])).toEqual({
      section: 0,
      start: 3,
      end: 6,
      blocks: [
        { id: 'b5', anchor: anchor(3) },
        { id: 'b6', anchor: anchor(5) },
      ],
    });
    expect(planCopySource(ids(), ['b2']).blocks).toEqual([
      { id: 'b2', anchor: anchor(1) },
      { id: 'b3', anchor: anchor(1, 'field:0') },
    ]);
  });

  it('이어지지 않은 블록·누름틀만 고르기·없는 id 는 거부한다', () => {
    expect(() => planCopySource(ids(), ['b6', 'b8'])).toThrow('복사할 블록이 문서에서 이어져 있지 않습니다. 사이 블록 b7 도 ids 에 넣거나 따로 복사하세요.');
    expect(() => planCopySource(ids(), ['b3'])).toThrow('b3: 누름틀 블록만 복사할 수는 없습니다. 누름틀이 든 블록 b2 를 복사하세요.');
    expect(() => planCopySource(ids(), ['b2', 'b99'])).toThrow('없는 블록 id 입니다: b99.');
  });
});

describe('SPEC-007 copy_blocks — 대상 탭 편집 (편집 공용 경로)', () => {
  const source = sourceOf(buildCopySource());

  it('AC-5 원본 문단·누름틀 문단·번호 문단·표를 서식째 넣고, 넣은 문단마다 새 id 를 받을 블록(문단 글자·표·누름틀)을 돌려준다', () => {
    const target = new DocumentEditor(openFixture('report.hwpx'));
    const before = outlineOf(target.blocks);
    const sourceBefore = outlineOf(extractBlocks(source.doc));

    // b2(수신 + 누름틀) ~ b12(표): 원본 문단 1~11 → 대상 b1(문단 0) 뒤
    const { changes, changed } = target.edit(copyOperation(source, idRange(2, 12), target, 'b1', 'after'), 0);

    expect(changes?.inserted).toEqual([
      { section: S, paragraph: 1, parts: ['text', 'field:0'] },
      { section: S, paragraph: 2, parts: ['text'] },
      { section: S, paragraph: 3, parts: ['text'] },
      { section: S, paragraph: 4, parts: [] }, // 원본 문단 4 는 블록이 없는 빈 문단 — 대상에서도 블록이 아니다
      ...[5, 6, 7, 8, 9, 10].map((paragraph) => ({ section: S, paragraph, parts: ['text'] })),
      { section: S, paragraph: 11, parts: ['table:0'] },
    ]);
    const outline = outlineOf(target.blocks);
    expect(outline.slice(1, 12)).toEqual(sourceBefore.slice(1, 12));
    expect(outline.slice(12)).toEqual(before.slice(1));
    // 바뀐 블록 = 넣은 문단의 블록 모두(대상 번호가 다시 매겨진 문단이 있으면 뒤에 더 붙는다)
    expect(changed.slice(0, 11).map(({ anchor }) => `${anchor.paragraph}:${anchor.part}`)).toEqual([
      '1:text', '1:field:0', '2:text', '3:text', '5:text', '6:text', '7:text', '8:text', '9:text', '10:text', '11:table:0',
    ]);
    // 원본은 그대로
    expect(outlineOf(extractBlocks(source.doc))).toEqual(sourceBefore);
  });

  it('AC-5 되돌리면 넣은 문단과 더한 스타일·번호 정의까지 한 번에 돌아간다', () => {
    const target = new DocumentEditor(openFixture('application.hwpx'));
    const before = { outline: outlineOf(target.blocks), styles: styleNames(target.doc) };
    // "강조 문단" 스타일 문단(원본에만 있는 스타일)
    const emphasis = source.ids.idAt({ section: S, paragraph: 16, part: 'text' });
    if (emphasis === undefined) throw new Error('강조 문단 블록이 없다');
    target.edit(copyOperation(source, [emphasis], target, 'b1', 'after'), 0);
    expect(styleNames(target.doc)).toContain(SOURCE_ONLY_STYLE.name);

    expect(target.undo(1, 1)).toBe(1);

    expect(outlineOf(target.blocks)).toEqual(before.outline);
    expect(styleNames(target.doc)).toEqual(before.styles);
  });

  it('보정 중 예외가 나면(applyStyle) 스냅샷으로 되돌아가 대상 문서가 반쯤 바뀌지 않는다', () => {
    const target = new DocumentEditor(openFixture('report.hwpx'));
    const before = { outline: outlineOf(target.blocks), styles: styleNames(target.doc), count: target.doc.getParagraphCount(S) };
    vi.spyOn(target.doc, 'applyStyle').mockImplementation(() => {
      throw new Error('보정 실패');
    });

    expect(() => target.edit(copyOperation(source, idRange(6, 11), target, 'b1', 'after'), 0)).toThrow('보정 실패');

    expect(target.doc.getParagraphCount(S)).toBe(before.count);
    expect(styleNames(target.doc)).toEqual(before.styles);
    expect(outlineOf(extractBlocks(target.doc))).toEqual(before.outline);
    expect(target.depth).toBe(0);
  });

  it('각주처럼 가져올 수 없는 개체가 든 문단이 범위에 있으면 아무것도 넣지 않고 원본 블록 id 와 이유로 거부한다', () => {
    const doc = createBlankDocument();
    doc.insertText(S, 0, 0, '첫째');
    doc.splitParagraph(S, 0, 2);
    doc.insertText(S, 1, 0, '보통 문단');
    doc.splitParagraph(S, 1, 5);
    doc.insertText(S, 2, 0, '각주 문단');
    doc.insertFootnote(S, 2, 2);
    const footnoteSource = sourceOf(doc);
    const target = new DocumentEditor(openFixture('report.hwpx'));
    const before = outlineOf(target.blocks);

    expect(() => target.edit(copyOperation(footnoteSource, ['b2', 'b3'], target, 'b1', 'after'), 0)).toThrow(
      '이 문단은 복사할 수 없습니다(각주): b3. 글자만 가져오려면 read_blocks 와 insert_paragraph 를 쓰세요.',
    );
    expect(outlineOf(target.blocks)).toEqual(before);
    expect(target.depth).toBe(0);
  });

  it('넣은 문단의 블록이 알린 블록(원본 꼬리표)과 다르면 되돌린다 — 서버가 없는 블록에 id 를 주지 않게. 더한 스타일·되돌리기 칸도 남지 않는다', () => {
    const target = new DocumentEditor(openFixture('report.hwpx'));
    const before = { outline: outlineOf(target.blocks), styles: styleNames(target.doc), count: target.doc.getParagraphCount(S) };
    // "강조 문단" 스타일 문단(원본에만 있는 스타일) — 넣기·스타일 보정이 다 끝난 뒤 블록 확인에서 던진다
    const emphasis = source.ids.idAt({ section: S, paragraph: 16, part: 'text' });
    if (emphasis === undefined) throw new Error('강조 문단 블록이 없다');
    const operation = copyOperation(source, [emphasis], target, 'b1', 'after');
    if (operation.kind !== 'copy_blocks') throw new Error('copy_blocks 편집이 아니다');
    // 원본 문단 글자 블록을 표라고 잘못 알린다
    const wrong = { ...operation, source: { ...operation.source, blocks: operation.source.blocks.map((b) => ({ ...b, anchor: { ...b.anchor, part: 'table:0' } })) } };

    expect(() => target.edit(wrong, 0)).toThrow('넣은 문단(구역 0 문단 1)의 블록이 예상과 다릅니다(예상 table:0, 실제 text). 넣지 않았습니다.');
    expect(outlineOf(extractBlocks(target.doc))).toEqual(before.outline);
    expect(target.doc.getParagraphCount(S)).toBe(before.count);
    expect(styleNames(target.doc)).toEqual(before.styles);
    expect(target.depth).toBe(0);
  });

  it('대상 구역 첫 문단 앞에는 넣지 않는다(insert_paragraph 와 같은 기준 규칙)', () => {
    const target = new DocumentEditor(openFixture('report.hwpx'));

    expect(() => target.edit(copyOperation(source, ['b6'], target, 'b1', 'before'), 0)).toThrow('구역 첫 문단 앞에는 넣을 수 없습니다.');
  });
});
