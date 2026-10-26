// 문서를 Claude 에게 보여줄 블록(본문 문단·표·누름틀) 목록으로 바꾼다.
// 기술 검증(#4)용 프로토타입: rhwp 공개 API 만으로 블록을 뽑을 수 있는지 확인한다.
import type { HwpDocument } from '@rhwp/core';
import { z } from 'zod';

export interface ParagraphBlock {
  kind: 'paragraph';
  section: number;
  paragraph: number;
  /** 1부터 시작하는 쪽 번호 */
  page: number;
  text: string;
  /** 자동 번호(문단 번호·개요 번호) 문단이면 화면에 그려지는 번호 문자열 */
  number?: string;
  /** 개요 문단이면 개요 수준(1부터) */
  outlineLevel?: number;
}

export interface TableCell {
  row: number;
  col: number;
  text: string;
  /** 같은 행 첫 칸의 텍스트(칸 라벨) */
  rowLabel: string;
}

export interface TableBlock {
  kind: 'table';
  section: number;
  /** 표를 품은 본문 문단 */
  paragraph: number;
  controlIndex: number;
  page: number;
  rowCount: number;
  colCount: number;
  cells: TableCell[];
}

export interface FieldBlock {
  kind: 'field';
  section: number;
  /** 누름틀이 있는 본문 문단(표 안이면 표를 품은 문단) */
  paragraph: number;
  name: string;
  guide: string;
  value: string;
  inTable: boolean;
}

export type Block = ParagraphBlock | TableBlock | FieldBlock;

const controlsSchema = z.array(
  z.object({ ctrlId: z.string(), list: z.number(), para: z.number(), controlIndex: z.number() }),
);
const pageOfPositionSchema = z.object({ page: z.number() });
const tableDimensionsSchema = z.object({ rowCount: z.number(), colCount: z.number(), cellCount: z.number() });
const cellInfoSchema = z.object({ row: z.number(), col: z.number(), rowSpan: z.number(), colSpan: z.number() });
const paraPropertiesSchema = z.object({ headType: z.string(), paraLevel: z.number() });
const textLayoutSchema = z.object({
  runs: z.array(
    z.object({
      text: z.string(),
      secIdx: z.number().optional(),
      paraIdx: z.number().optional(),
      charStart: z.number().optional(),
      cellIdx: z.number().optional(),
    }),
  ),
});
const fieldListSchema = z.array(
  z.object({
    fieldType: z.string(),
    name: z.string(),
    guide: z.string(),
    value: z.string(),
    location: z.object({
      sectionIndex: z.number(),
      paraIndex: z.number(),
      path: z.array(z.unknown()).optional(),
    }),
  }),
);

function parse<T>(schema: z.ZodType<T>, json: string): T {
  return schema.parse(JSON.parse(json));
}

function paragraphText(doc: HwpDocument, section: number, paragraph: number): string {
  return doc.getTextRange(section, paragraph, 0, doc.getParagraphLength(section, paragraph));
}

function pageOf(doc: HwpDocument, section: number, paragraph: number): number {
  return parse(pageOfPositionSchema, doc.getPageOfPosition(section, paragraph)).page + 1;
}

const positionKey = (section: number, paragraph: number) => `${section}:${paragraph}`;

export type LayoutRun = z.infer<typeof textLayoutSchema>['runs'][number];

// 자동 번호는 문서에 숫자로 저장되지 않고 렌더링 때 계산된다(rhwp-code-analysis 2-4).
// getOutlineNavigation 은 개요 번호만 주므로, 쪽 글자 배치에서 문단 첫 글자 바로 앞에
// 그려진 번호 글자를 읽는다. 번호 글자 자체에는 문단 위치가 붙지 않는다.
/** 쪽마다의 글자 배치(run 목록)에서 문단별 번호 문자열을 찾는다 */
export function numbersFromLayout(pages: LayoutRun[][]): Map<string, string> {
  const numbers = new Map<string, string>();
  for (const runs of pages) {
    runs.forEach((run, i) => {
      const previous = runs[i - 1];
      if (
        previous === undefined ||
        previous.paraIdx !== undefined ||
        run.paraIdx === undefined ||
        run.secIdx === undefined ||
        run.cellIdx !== undefined ||
        // 번호는 문단 첫 줄 앞에만 그려진다. 다음 쪽으로 이어지는 줄 앞의 머리말·쪽 번호는 번호가 아니다
        run.charStart !== 0
      ) {
        return;
      }
      const key = positionKey(run.secIdx, run.paraIdx);
      if (!numbers.has(key)) numbers.set(key, previous.text);
    });
  }
  return numbers;
}

function renderedNumbers(doc: HwpDocument): Map<string, string> {
  const pages: LayoutRun[][] = [];
  for (let page = 0; page < doc.pageCount(); page += 1) {
    pages.push(parse(textLayoutSchema, doc.getPageTextLayout(page)).runs);
  }
  return numbersFromLayout(pages);
}

function numberingOf(
  doc: HwpDocument,
  section: number,
  paragraph: number,
  numbers: Map<string, string>,
): Pick<ParagraphBlock, 'number' | 'outlineLevel'> {
  const { headType, paraLevel } = parse(paraPropertiesSchema, doc.getParaPropertiesAt(section, paragraph));
  if (headType !== 'Number' && headType !== 'Outline') return {};
  const number = numbers.get(positionKey(section, paragraph));
  return {
    ...(number === undefined ? {} : { number }),
    ...(headType === 'Outline' ? { outlineLevel: paraLevel + 1 } : {}),
  };
}

function cellText(doc: HwpDocument, section: number, paragraph: number, control: number, cell: number): string {
  const count = doc.getCellParagraphCount(section, paragraph, control, cell);
  const lines: string[] = [];
  for (let p = 0; p < count; p += 1) {
    const length = doc.getCellParagraphLength(section, paragraph, control, cell, p);
    lines.push(doc.getTextInCell(section, paragraph, control, cell, p, 0, length));
  }
  return lines.join('\n');
}

function readTable(doc: HwpDocument, section: number, paragraph: number, controlIndex: number): TableBlock {
  const { rowCount, colCount, cellCount } = parse(
    tableDimensionsSchema,
    doc.getTableDimensions(section, paragraph, controlIndex),
  );
  const raw = Array.from({ length: cellCount }, (_, cellIdx) => ({
    ...parse(cellInfoSchema, doc.getCellInfo(section, paragraph, controlIndex, cellIdx)),
    text: cellText(doc, section, paragraph, controlIndex, cellIdx),
  }));
  const labelOf = (row: number) =>
    raw.find((c) => c.col === 0 && c.row <= row && row < c.row + c.rowSpan)?.text ?? '';
  return {
    kind: 'table',
    section,
    paragraph,
    controlIndex,
    page: pageOf(doc, section, paragraph),
    rowCount,
    colCount,
    cells: raw.map(({ row, col, text }) => ({ row, col, text, rowLabel: labelOf(row) })),
  };
}

// getControls 의 para 는 구역을 이어 붙인 문서 전체 문단 번호다.
// list 0 이 본문이고, 그 밖의 list 는 표 칸·글상자 안이다(표 안 표는 바깥 표 블록에 속한다).
function tablesByParagraph(doc: HwpDocument): Map<string, number[]> {
  const sectionStarts: number[] = [];
  let total = 0;
  for (let s = 0; s < doc.getSectionCount(); s += 1) {
    sectionStarts.push(total);
    total += doc.getParagraphCount(s);
  }
  const tables = new Map<string, number[]>();
  for (const control of parse(controlsSchema, doc.getControls())) {
    if (control.ctrlId !== 'tbl' || control.list !== 0) continue;
    const section = sectionStarts.findLastIndex((start) => start <= control.para);
    const key = positionKey(section, control.para - (sectionStarts[section] ?? 0));
    tables.set(key, [...(tables.get(key) ?? []), control.controlIndex]);
  }
  return tables;
}

function fieldsByParagraph(doc: HwpDocument): Map<string, FieldBlock[]> {
  const fields = new Map<string, FieldBlock[]>();
  for (const field of parse(fieldListSchema, doc.getFieldList())) {
    if (field.fieldType !== 'clickhere') continue;
    const { sectionIndex: section, paraIndex: paragraph, path } = field.location;
    const key = positionKey(section, paragraph);
    const block: FieldBlock = {
      kind: 'field',
      section,
      paragraph,
      name: field.name,
      guide: field.guide,
      value: field.value,
      inTable: (path?.length ?? 0) > 0,
    };
    fields.set(key, [...(fields.get(key) ?? []), block]);
  }
  return fields;
}

/** 본문 문단·표·누름틀을 문서 순서대로 돌려준다. 글자가 없는 문단은 블록으로 내보내지 않는다. */
export function extractBlocks(doc: HwpDocument): Block[] {
  const numbers = renderedNumbers(doc);
  const tables = tablesByParagraph(doc);
  const fields = fieldsByParagraph(doc);
  const blocks: Block[] = [];
  for (let section = 0; section < doc.getSectionCount(); section += 1) {
    for (let paragraph = 0; paragraph < doc.getParagraphCount(section); paragraph += 1) {
      const text = paragraphText(doc, section, paragraph);
      if (text.trim().length > 0) {
        blocks.push({
          kind: 'paragraph',
          section,
          paragraph,
          page: pageOf(doc, section, paragraph),
          text,
          ...numberingOf(doc, section, paragraph, numbers),
        });
      }
      const key = positionKey(section, paragraph);
      for (const controlIndex of tables.get(key) ?? []) {
        blocks.push(readTable(doc, section, paragraph, controlIndex));
      }
      blocks.push(...(fields.get(key) ?? []));
    }
  }
  return blocks;
}
