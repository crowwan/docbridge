// 문단 스타일(SPEC-003 "스타일 적용", ADR 003): 스타일 목록·이름으로 찾기·스타일 적용·제목 스타일.
// 뷰어(edit-operations.ts 편집 종류 set_style·insert_paragraph style, list_styles)와 새 문서 만들기(create-document.ts)가 같이 쓴다.
// rhwp 기본 동작이 스펙과 다른 곳만 바로잡는다(ADR 002 원칙 그대로):
// - applyStyle 은 문단에 직접 문단 모양이 있으면 그 모양을 그대로 둔다(개요 번호가 안 붙는다) → 스타일의 문단 모양으로 맞춘다
// - createBlankDocument 의 스타일에는 "제목"이 없다 → "제목" 스타일이 없는 문서에 docbridge 제목 스타일을 하나 더한다
import type { HwpDocument } from '@rhwp/core';
import { z } from 'zod';
import type { AnchoredBlock } from './edit-operations.ts';
import { paraShapeIdOf } from './edits.ts';
import { parseJson } from './json.ts';

/** 바탕글 스타일 id(rhwp·한컴 문서 모두 0) */
export const NORMAL_STYLE = 0;

const styleListSchema = z.array(
  z.object({
    id: z.number(),
    name: z.string(),
    englishName: z.string(),
    type: z.number(),
    paraShapeId: z.number(),
    charShapeId: z.number(),
  }),
);
/** 스타일 정의 하나(getStyleList). 적용할 때 문단·글자 모양 id 를 같이 넘겨 목록을 다시 읽지 않는다 */
export type StyleEntry = z.infer<typeof styleListSchema>[number];
const styleDetailSchema = z.object({
  paraProps: z.looseObject({ paraShapeId: z.number(), headType: z.string(), paraLevel: z.number() }),
});

/** 문단 스타일 하나(뷰어 list_styles 결과) */
export const paragraphStyleSchema = z.object({
  id: z.number(),
  name: z.string(),
  englishName: z.string(),
  /** 개요 스타일이면 개요 수준(1부터). 이 스타일 문단은 개요 번호를 받는다 */
  outlineLevel: z.number().optional(),
});
export type ParagraphStyle = z.infer<typeof paragraphStyleSchema>;

/**
 * rhwp getStyleList 의 type 은 HWP 스타일 속성 바이트 그대로다. 문단 0 / 글자 1 인데, 한컴 HWP 5 바이너리 일부는
 * 다른 비트가 섞여 문단 스타일도 4·108 로 온다(로컬 한컴 문서 2개). 그래서 글자 스타일 비트(가장 낮은 비트)만 본다
 */
const CHARACTER_STYLE_BIT = 0b1;
const isParagraphStyle = ({ type }: StyleEntry) => (type & CHARACTER_STYLE_BIT) === 0;

/** 문단 스타일 목록(글자 스타일 빼고). getStyleList 한 번만 읽는다 */
const paragraphStyleEntries = (doc: HwpDocument): StyleEntry[] => parseJson(styleListSchema, doc.getStyleList()).filter(isParagraphStyle);

/** 스타일 id → 정의. 없으면 던진다(바탕글 NORMAL_STYLE·ensureTitleStyle 의 id 처럼 id 를 아는 쪽) */
export function styleById(doc: HwpDocument, styleId: number): StyleEntry {
  const found = parseJson(styleListSchema, doc.getStyleList()).find(({ id }) => id === styleId);
  if (found === undefined) throw new Error(`스타일 ${styleId} 이 문서에 없습니다.`);
  return found;
}

/**
 * 문서의 문단 스타일(글자 스타일 빼고, 문서의 스타일 순서). 개요 번호 여부는 스타일 이름이 아니라 스타일 문단 모양의 headType 으로 본다
 * (한컴 공문 양식은 "개요 1" 을 번호 없는 모양으로 바꿔 쓰기도 한다 — 로컬 한컴 기안문).
 * rhwp getStyleDetail 은 스타일 문단 모양에 번호가 없으면 그 스타일을 쓰는 문단 중 번호 있는 첫 문단의 모양을 준다
 * (바탕글 문단에 직접 개요 모양을 건 문서에서 바탕글이 개요로 나온다 — #37). 그래서 돌려준 모양이 스타일 것일 때만 믿는다
 */
export function paragraphStyles(doc: HwpDocument): ParagraphStyle[] {
  return paragraphStyleEntries(doc).map(({ id, name, englishName, paraShapeId }) => {
    const { paraProps } = parseJson(styleDetailSchema, doc.getStyleDetail(id));
    const outline = paraProps.headType === 'Outline' && paraProps.paraShapeId === paraShapeId;
    return outline ? { id, name, englishName, outlineLevel: paraProps.paraLevel + 1 } : { id, name, englishName };
  });
}

export const unknownStyleMessage = (name: string) =>
  `없는 스타일입니다: ${name.trim() === '' ? '(빈 이름)' : name}. list_styles 로 목록을 보세요.`;
export const ambiguousStyleMessage = (name: string, names: string[]) =>
  `영문 이름이 ${name} 인 스타일이 여럿입니다(${names.join(', ')}). 한글 이름으로 고르세요.`;

/**
 * 스타일 이름 → 문단 스타일 정의. 한글 이름이 같은 스타일을 먼저 보고, 없을 때만 영문 이름으로 찾는다
 * (한 스타일의 영문 이름이 다른 스타일의 한글 이름과 같을 수 있다). 빈 이름·없는 이름은 던지고,
 * 영문 이름이 여럿에 맞으면 모호하다고 던진다(한컴 사용자 스타일은 영문 이름이 비었거나 겹치기도 한다)
 */
export function findStyle(doc: HwpDocument, name: string): StyleEntry {
  if (name.trim() === '') throw new Error(unknownStyleMessage(name));
  const styles = paragraphStyleEntries(doc);
  const byName = styles.find((style) => style.name === name);
  if (byName !== undefined) return byName;
  const byEnglish = styles.filter((style) => style.englishName === name);
  const [only, ...others] = byEnglish;
  if (only === undefined) throw new Error(unknownStyleMessage(name));
  if (others.length > 0) throw new Error(ambiguousStyleMessage(name, byEnglish.map((style) => style.name)));
  return only;
}

/**
 * 본문 문단에 문단 스타일을 건다(set_style). 문단 모양은 스타일 것으로 맞추고(직접 문단 모양은 버린다),
 * 글자 모양은 rhwp 대로 스타일 글자 모양이던 글자만 새 스타일 글자 모양이 되고 직접 서식(굵게 등)은 남는다
 */
export function applyParagraphStyle(doc: HwpDocument, section: number, paragraph: number, style: StyleEntry): void {
  doc.applyStyle(section, paragraph, style.id);
  // rhwp applyStyle 은 문단 모양이 옛 스타일 것과 다르면(직접 문단 모양) 그대로 둔다 → 개요 스타일이어도 번호가 안 붙는다
  if (paraShapeIdOf(doc, section, paragraph) !== style.paraShapeId) doc.setParaShapeId(section, paragraph, style.paraShapeId);
}

/**
 * 문단을 스타일 모양 그대로로: 스타일을 걸고 글자 모양도 직접 서식 없이 스타일 글자 모양으로 덮는다.
 * style 로 넣은 새 문단, 비운 양식 첫 문단·표를 담을 새 문단처럼 버릴 글자 서식만 있는 문단에 쓴다
 * (applyStyle 은 스타일 밖 글자 모양을 직접 서식으로 보고 남긴다. 빈 문단도 setCharShapeId(0, 0) 이 그 뒤에 넣는 글자 모양이 된다)
 */
export function resetToStyle(doc: HwpDocument, section: number, paragraph: number, style: StyleEntry): void {
  applyParagraphStyle(doc, section, paragraph, style);
  doc.setCharShapeId(section, paragraph, 0, doc.getParagraphLength(section, paragraph), style.charShapeId);
}

/** set_style 대상은 문단 블록만(SPEC-003). 표·누름틀 블록이면 던진다. 서버가 뷰어에 보내기 전에 부른다(뷰어는 블록 종류를 본다) */
export function assertStylable(targets: AnchoredBlock[]): void {
  const others = targets.filter(({ anchor }) => anchor.part !== 'text').map(({ id }) => id);
  if (others.length > 0) {
    throw new Error(
      `표·누름틀 블록은 스타일을 바꿀 수 없습니다: ${others.join(', ')}. 문단 블록 id 를 주세요(표·누름틀이 든 문단은 get_outline 의 그 문단 블록).`,
    );
  }
}

/** docbridge 가 "제목" 스타일이 없는 문서에 더하는 제목 스타일(빈 문서 템플릿에는 "제목"이 없다). 가운데 정렬, 20pt 굵게, 다음 문단은 본문 */
export const TITLE_STYLE = { name: '제목', englishName: 'Title', fontSize: 2000 } as const;

/** 제목 스타일(한글 이름 "제목" 또는 영문 이름 "Title")이 없으면 만든다. 스타일 id 를 돌려준다 */
export function ensureTitleStyle(doc: HwpDocument): number {
  const styles = paragraphStyleEntries(doc);
  const existing = styles.find(({ name, englishName }) => name === TITLE_STYLE.name || englishName === TITLE_STYLE.englishName);
  if (existing !== undefined) return existing.id;
  const body = styles.find(({ englishName }) => englishName === 'Body')?.id ?? NORMAL_STYLE;
  const id = doc.createStyle(JSON.stringify({ name: TITLE_STYLE.name, englishName: TITLE_STYLE.englishName, type: 0, nextStyleId: body }));
  let shaped = false;
  try {
    shaped = doc.updateStyleShapes(id, JSON.stringify({ fontSize: TITLE_STYLE.fontSize, bold: true }), JSON.stringify({ alignment: 'center' }));
  } finally {
    // 모양 없는 "제목" 이 남으면 다음 호출이 그것을 정상 제목 스타일로 돌려준다
    if (!shaped) doc.deleteStyle(id);
  }
  if (!shaped) throw new Error('제목 스타일의 모양을 정하지 못했습니다.');
  return id;
}
