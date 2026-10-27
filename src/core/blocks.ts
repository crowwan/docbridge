// 문서를 Claude 에게 보여줄 블록(본문 문단·표·누름틀) 목록으로 바꾼다. rhwp 공개 API 만 쓴다.
import type { HwpDocument } from '@rhwp/core';
import { z } from 'zod';
import { BODY_LIST, bodyParagraphLocator } from './body-paragraphs.ts';
import { parseJson } from './json.ts';
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

function paragraphText(doc: HwpDocument, section: number, paragraph: number): string {
  return doc.getTextRange(section, paragraph, 0, doc.getParagraphLength(section, paragraph));
}

function pageOf(doc: HwpDocument, section: number, paragraph: number): number {
  return parseJson(pageOfPositionSchema, doc.getPageOfPosition(section, paragraph)).page + 1;
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

/** 번호를 찾을 문단: 위치 키와 문단이 시작하는 쪽(0부터) */
export interface NumberedParagraph {
  key: string;
  page: number;
}

/**
 * 번호 문단마다 번호 문자열을 찾는다. 쪽 글자 배치는 쪽마다 큰 JSON 이라 필요한 쪽만, 쪽마다 한 번만 읽는다.
 * 시작 쪽에서 먼저 찾고, 없으면 다음 쪽도 본다. 쪽 나눔·조판 부호로 시작하거나 쪽 경계에 걸린 문단은
 * 시작 위치(getPageOfPosition) 쪽과 번호가 그려진 쪽이 다를 수 있다(PR #12 리뷰).
 */
export function numbersForParagraphs(
  wanted: NumberedParagraph[],
  pageCount: number,
  readPage: (page: number) => LayoutRun[],
): Map<string, string> {
  const byPage = new Map<number, Map<string, string>>();
  const numbersOn = (page: number) => {
    const cached = byPage.get(page);
    if (cached) return cached;
    const found = numbersFromLayout([readPage(page)]);
    byPage.set(page, found);
    return found;
  };
  const numbers = new Map<string, string>();
  for (const { key, page } of wanted) {
    for (const candidate of [page, page + 1]) {
      if (candidate >= pageCount) break;
      const number = numbersOn(candidate).get(key);
      if (number !== undefined) {
        numbers.set(key, number);
        break;
      }
    }
  }
  return numbers;
}

/** 자동 번호 문단의 머리 모양. 번호가 없는 문단이면 undefined */
interface Heading {
  outline: boolean;
  /** 0부터 */
  level: number;
}

function headingOf(doc: HwpDocument, section: number, paragraph: number): Heading | undefined {
  const { headType, paraLevel } = parseJson(paraPropertiesSchema, doc.getParaPropertiesAt(section, paragraph));
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

/** 표 칸 안 문단들의 글자. 칸 text 는 이것을 \n 으로 이은 것이다(하이라이트가 칸 안 위치를 문단으로 나눌 때도 쓴다) */
export function cellParagraphTexts(doc: HwpDocument, section: number, paragraph: number, control: number, cell: number): string[] {
  const count = doc.getCellParagraphCount(section, paragraph, control, cell);
  const lines: string[] = [];
  for (let p = 0; p < count; p += 1) {
    const length = doc.getCellParagraphLength(section, paragraph, control, cell, p);
    lines.push(doc.getTextInCell(section, paragraph, control, cell, p, 0, length));
  }
  return lines;
}

const cellText = (doc: HwpDocument, section: number, paragraph: number, control: number, cell: number) =>
  cellParagraphTexts(doc, section, paragraph, control, cell).join('\n');

function readTable(doc: HwpDocument, section: number, paragraph: number, controlIndex: number): TableBlock {
  const { rowCount, colCount, cellCount } = parseJson(
    tableDimensionsSchema,
    doc.getTableDimensions(section, paragraph, controlIndex),
  );
  const raw = Array.from({ length: cellCount }, (_, cellIdx) => ({
    ...parseJson(cellInfoSchema, doc.getCellInfo(section, paragraph, controlIndex, cellIdx)),
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

// 본문(list 0)의 표만 블록이다. 그 밖의 list 는 표 칸·글상자 안이다(표 안 표는 바깥 표 블록에 속한다).
// getControls 의 para 는 문서 전체 문단 번호라 bodyParagraphLocator 로 (구역, 문단)으로 바꾼다
function tablesByParagraph(doc: HwpDocument): Map<string, number[]> {
  const locate = bodyParagraphLocator(doc);
  const tables = new Map<string, number[]>();
  for (const control of parseJson(controlsSchema, doc.getControls())) {
    if (control.ctrlId !== 'tbl' || control.list !== BODY_LIST) continue;
    const { section, paragraph } = locate(control.para);
    const key = positionKey(section, paragraph);
    tables.set(key, [...(tables.get(key) ?? []), control.controlIndex]);
  }
  return tables;
}

function fieldsByParagraph(doc: HwpDocument): Map<string, FieldBlock[]> {
  const fields = new Map<string, FieldBlock[]>();
  for (const field of parseJson(fieldListSchema, doc.getFieldList())) {
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

/**
 * 본문 문단·표·누름틀을 문서 순서대로 돌려준다. 글자가 없는 문단은 블록으로 내보내지 않는다.
 * keepEmpty 가 참인 문단은 비어 있어도 문단 블록으로 남긴다(편집으로 비운 문단은 id 가 있어 다시 채울 수 있어야 한다, SPEC-002)
 */
export function extractBlocks(doc: HwpDocument, keepEmpty: (section: number, paragraph: number) => boolean = () => false): Block[] {
  const tables = tablesByParagraph(doc);
  const fields = fieldsByParagraph(doc);
  const body: BodyParagraph[] = [];
  for (let section = 0; section < doc.getSectionCount(); section += 1) {
    for (let paragraph = 0; paragraph < doc.getParagraphCount(section); paragraph += 1) {
      const text = paragraphText(doc, section, paragraph);
      if (text.trim().length === 0 && !keepEmpty(section, paragraph)) {
        body.push({ section, paragraph, block: undefined, heading: undefined });
        continue;
      }
      const block: ParagraphBlock = { kind: 'paragraph', section, paragraph, page: pageOf(doc, section, paragraph), text };
      body.push({ section, paragraph, block, heading: headingOf(doc, section, paragraph) });
    }
  }
  const wanted = body.flatMap(({ section, paragraph, block, heading }) =>
    block && heading ? [{ key: positionKey(section, paragraph), page: block.page - 1 }] : [],
  );
  const numbers = numbersForParagraphs(wanted, doc.pageCount(), (page) =>
    parseJson(textLayoutSchema, doc.getPageTextLayout(page)).runs,
  );
  return body.flatMap(({ section, paragraph, block, heading }) => {
    const key = positionKey(section, paragraph);
    return [
      ...(block ? [{ ...block, ...numberingOf(heading, numbers.get(key)) }] : []),
      ...(tables.get(key) ?? []).map((controlIndex) => readTable(doc, section, paragraph, controlIndex)),
      ...(fields.get(key) ?? []),
    ];
  });
}
