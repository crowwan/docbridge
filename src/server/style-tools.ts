// 스타일 도구(SPEC-003): list_styles 는 뷰어 문서의 문단 스타일 목록을, set_style 은 편집 공용 경로(session.edit)로 문단 스타일을 바꾼다.
// 스타일 이름 → id 와 적용은 문서를 가진 뷰어가 한다(core/styles.ts). insert_paragraph 의 style 은 edit-tools.ts.
import type { ParagraphStyle } from '../core/styles.ts';
import { assertStylable } from '../core/styles.ts';
import { numberedItem, unmarkedMessage, type MovedItem } from './edit-tools.ts';
import { anchored } from './highlight-tools.ts';
import type { DocumentSession } from './session.ts';

export interface StyleItem {
  name: string;
  englishName: string;
  /** 이 스타일 문단이 개요 번호를 받는지(이름이 아니라 스타일 문단 모양으로) */
  outline: boolean;
  /** 개요 스타일이면 개요 수준(1부터) */
  outlineLevel?: number;
}

/** 뷰어 스타일 → 도구 결과 항목. id 는 내보내지 않는다(이름으로 고른다). create_document 결과의 스타일 목록도 이것 */
export const styleItems = (styles: ParagraphStyle[]): StyleItem[] =>
  styles.map(({ name, englishName, outlineLevel }) =>
    outlineLevel === undefined ? { name, englishName, outline: false } : { name, englishName, outline: true, outlineLevel },
  );

export async function listStyles(session: DocumentSession): Promise<{ styles: StyleItem[] }> {
  return { styles: styleItems(await session.requestViewer('list_styles', {})) };
}

export interface SetStyleResult {
  /** 고른 문단과 개요 번호가 바뀐 문단(문서 순서). number 는 바꾼 뒤 자동 번호 */
  changed: MovedItem[];
  /** 뷰어에 표시하지 못한 블록 */
  warnings?: string[];
}

/** 문단 블록들의 스타일을 바꾼다(여러 id 도 편집 하나). 표·누름틀 블록은 뷰어에 보내기 전에 거부한다 */
export async function setStyle(session: DocumentSession, ids: string[], style: string): Promise<SetStyleResult> {
  const unique = [...new Set(ids)];
  const { changed, unmarked } = await session.edit((document) => {
    const targets = anchored(document.ids, unique.map((id) => ({ id }))).map(({ id, anchor }) => ({ id, anchor }));
    assertStylable(targets);
    return { label: `set_style ${unique.join(', ')} → ${style}`, operation: { kind: 'set_style', targets, style } };
  });
  return {
    changed: changed.flatMap(numberedItem),
    ...(unmarked.length === 0 ? {} : { warnings: unmarked.map(unmarkedMessage) }),
  };
}
