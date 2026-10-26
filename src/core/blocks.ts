// 문서를 Claude 에게 보여줄 블록(본문 문단·표·누름틀) 목록으로 바꾼다. rhwp 공개 API 만 쓴다.
import type { HwpDocument } from '@rhwp/core';
import { z } from 'zod';
import type { Block, FieldBlock, ParagraphBlock, TableBlock } from './block-schema.ts';

export type { Block, FieldBlock, ParagraphBlock, TableBlock, TableCell } from './block-schema.ts';


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

/** 쪽 글자 배치는 쪽마다 큰 JSON 이라, 번호 문단이 시작하는 쪽(0부터)만 읽는다 */
function renderedNumbers(doc: HwpDocument, pageIndexes: Set<number>): Map<string, string> {
  const pages = [...pageIndexes]
    .sort((a, b) => a - b)
    .map((page) => parse(textLayoutSchema, doc.getPageTextLayout(page)).runs);
  return numbersFromLayout(pages);
}

/** 자동 번호 문단의 머리 모양. 번호가 없는 문단이면 undefined */
interface Heading {
  outline: boolean;
  /** 0부터 */
  level: number;
}

function headingOf(doc: HwpDocument, section: number, paragraph: number): Heading | undefined {
  const { headType, paraLevel } = parse(paraPropertiesSchema, doc.getParaPropertiesAt(section, paragraph));
  if (headType !== 'Number' && headType !== 'Outline') return undefined;
  return { outline: headType === 'Outline', level: paraLevel };
}

function numberingOf(heading: Heading | undefined, number: string | undefined): Pick<ParagraphBlock, 'number' | 'outlineLevel'> {
  if (heading === undefined) return {};
  return {
    ...(number === undefined ? {} : { number }),
    ...(heading.outline ? { outlineLevel: heading.level + 1 } : {}),
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
// 구역 첫 문단 번호는 getParagraphCount 합으로 구한다. getSectionStarts 는 구역 정의(SectionDef) 표식이
// 든 문단까지 구역 시작으로 세서(구역 하나에 [0, 1] 이 나올 수 있다) 이 번호와 맞지 않는다(#6, 테스트).
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
      page: pageOf(doc, section, paragraph),
      name: field.name,
      guide: field.guide,
      value: field.value,
      inTable: (path?.length ?? 0) > 0,
    };
    fields.set(key, [...(fields.get(key) ?? []), block]);
  }
  return fields;
}

interface BodyParagraph {
  section: number;
  paragraph: number;
  /** 글자가 없는 문단(표만 품은 문단 등)이면 undefined */
  block: ParagraphBlock | undefined;
  heading: Heading | undefined;
}

/** 본문 문단·표·누름틀을 문서 순서대로 돌려준다. 글자가 없는 문단은 블록으로 내보내지 않는다. */
export function extractBlocks(doc: HwpDocument): Block[] {
  const tables = tablesByParagraph(doc);
  const fields = fieldsByParagraph(doc);
  const body: BodyParagraph[] = [];
  for (let section = 0; section < doc.getSectionCount(); section += 1) {
    for (let paragraph = 0; paragraph < doc.getParagraphCount(section); paragraph += 1) {
      const text = paragraphText(doc, section, paragraph);
      if (text.trim().length === 0) {
        body.push({ section, paragraph, block: undefined, heading: undefined });
        continue;
      }
      const block: ParagraphBlock = { kind: 'paragraph', section, paragraph, page: pageOf(doc, section, paragraph), text };
      body.push({ section, paragraph, block, heading: headingOf(doc, section, paragraph) });
    }
  }
  const numberPages = new Set(body.flatMap(({ block, heading }) => (block && heading ? [block.page - 1] : [])));
  const numbers = renderedNumbers(doc, numberPages);
  return body.flatMap(({ section, paragraph, block, heading }) => {
    const key = positionKey(section, paragraph);
    return [
      ...(block ? [{ ...block, ...numberingOf(heading, numbers.get(key)) }] : []),
      ...(tables.get(key) ?? []).map((controlIndex) => readTable(doc, section, paragraph, controlIndex)),
      ...(fields.get(key) ?? []),
    ];
  });
}
