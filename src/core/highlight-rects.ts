// 하이라이트 사각형 계산.
// rhwp 0.8.7 의 getSelectionRects 는 범위가 줄 첫 글자에서 시작하면 그 줄 사각형의 왼쪽을
// 글자 시작이 아니라 단(column) 왼쪽 끝으로 준다. 그래서 가운데 정렬 줄, 번호 문단,
// 내어쓰기 줄에서는 하이라이트가 글자 앞 빈 곳이나 번호까지 덮는다(#4 기술 검증에서 확인).
// 줄마다 시작 글자의 캐럿 위치(getCursorRect)로 왼쪽 끝을 바로잡는다.
import type { HwpDocument } from '@rhwp/core';
import { z } from 'zod';

export interface CellLocation {
  parentParagraph: number;
  controlIndex: number;
  cellIndex: number;
}

export interface TextRange {
  section: number;
  /** 표 칸 안 범위면 칸 위치. 이때 문단 번호는 칸 안 문단 번호다 */
  cell?: CellLocation;
  startParagraph: number;
  startOffset: number;
  endParagraph: number;
  endOffset: number;
}

/** 쪽 왼쪽 위 기준 px(배율 1) */
export interface SelectionRect {
  pageIndex: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

const rectsSchema = z.array(
  z.object({ pageIndex: z.number(), x: z.number(), y: z.number(), width: z.number(), height: z.number() }),
);
const lineInfoSchema = z.object({ lineIndex: z.number(), charStart: z.number(), charEnd: z.number() });

// getCursorRectOnLine 의 parent_para_idx 에 이 값을 주면 본문 문단으로 본다
const BODY = 0xffffffff;
const caretSchema = z.object({ pageIndex: z.number(), x: z.number() });

// 본문 문단과 표 칸 문단은 API 이름만 다르다
interface ParagraphAccess {
  rawRects(range: TextRange): string;
  length(paragraph: number): number;
  lineInfo(paragraph: number, offset: number): string;
  caret(paragraph: number, offset: number): string;
  /** 줄 시작 캐럿. 줄 경계 글자 위치는 앞 줄 끝으로도 읽히므로 줄 번호로 묻는다 */
  lineStartCaret(paragraph: number, lineIndex: number): string;
}

function bodyAccess(doc: HwpDocument, section: number): ParagraphAccess {
  return {
    rawRects: (r) => doc.getSelectionRects(section, r.startParagraph, r.startOffset, r.endParagraph, r.endOffset),
    length: (p) => doc.getParagraphLength(section, p),
    lineInfo: (p, o) => doc.getLineInfo(section, p, o),
    caret: (p, o) => doc.getCursorRect(section, p, o),
    lineStartCaret: (p, line) => doc.getCursorRectOnLine(section, p, line, false, BODY, 0, 0, 0),
  };
}

function cellAccess(doc: HwpDocument, section: number, cell: CellLocation): ParagraphAccess {
  const { parentParagraph: pp, controlIndex: ci, cellIndex } = cell;
  return {
    rawRects: (r) =>
      doc.getSelectionRectsInCell(section, pp, ci, cellIndex, r.startParagraph, r.startOffset, r.endParagraph, r.endOffset),
    length: (p) => doc.getCellParagraphLength(section, pp, ci, cellIndex, p),
    lineInfo: (p, o) => doc.getLineInfoInCell(section, pp, ci, cellIndex, p, o),
    caret: (p, o) => doc.getCursorRectInCell(section, pp, ci, cellIndex, p, o),
    // 칸 경로면 rhwp 는 para_idx 를 쓰지 않고 칸 문맥(pp, ci, cellIndex, 칸 문단)만 본다 (rhwp def947c src/document_core/queries/cursor_nav.rs:492-517, 1058-1097)
    lineStartCaret: (p, line) => doc.getCursorRectOnLine(section, p, line, false, pp, ci, cellIndex, p),
  };
}

interface LineStart {
  paragraph: number;
  offset: number;
  lineIndex: number;
  /** 범위가 이 줄 첫 글자부터 시작하는지 */
  atLineStart: boolean;
}

// 범위가 지나는 줄마다 그 줄에서 범위가 시작하는 자리를 getSelectionRects 와 같은 순서로 만든다
function lineStarts(access: ParagraphAccess, range: TextRange): LineStart[] {
  const starts: LineStart[] = [];
  for (let paragraph = range.startParagraph; paragraph <= range.endParagraph; paragraph += 1) {
    const end = paragraph === range.endParagraph ? range.endOffset : access.length(paragraph);
    let offset = paragraph === range.startParagraph ? range.startOffset : 0;
    for (;;) {
      const line = lineInfoSchema.parse(JSON.parse(access.lineInfo(paragraph, offset)));
      starts.push({ paragraph, offset, lineIndex: line.lineIndex, atLineStart: offset === line.charStart });
      if (line.charEnd >= end || line.charEnd <= offset) break;
      offset = line.charEnd;
    }
  }
  return starts;
}

export function selectionRects(doc: HwpDocument, range: TextRange): SelectionRect[] {
  const access = range.cell ? cellAccess(doc, range.section, range.cell) : bodyAccess(doc, range.section);
  const raw = rectsSchema.parse(JSON.parse(access.rawRects(range)));
  const starts = lineStarts(access, range);
  // 줄 수가 맞지 않으면(빈 문단 등) 바로잡지 않고 rhwp 값을 그대로 쓴다
  if (starts.length !== raw.length) return raw;
  return raw.map((rect, i) => {
    const start = starts[i];
    if (start === undefined || !start.atLineStart) return rect;
    const caret = caretSchema.parse(JSON.parse(access.lineStartCaret(start.paragraph, start.lineIndex)));
    return alignLeftToCaret(rect, caret);
  });
}

/** 사각형 왼쪽을 줄 첫 글자 캐럿에 맞춘다. 캐럿이 사각형 안쪽(왼쪽 끝과 오른쪽 끝 사이)일 때만 바꾼다 */
export function alignLeftToCaret(rect: SelectionRect, caret: { pageIndex: number; x: number }): SelectionRect {
  const right = rect.x + rect.width;
  if (caret.pageIndex !== rect.pageIndex || caret.x <= rect.x || caret.x >= right) return rect;
  return { ...rect, x: caret.x, width: right - caret.x };
}
