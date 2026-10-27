// 블록 안 글자 위치의 단위: 유니코드 글자(code point).
// rhwp 의 글자 위치(getParagraphLength·getTextRange·getSelectionRects 등)가 이 단위다
// (빈 문서에 "𠀀😀가나" 를 넣으면 길이 4, 위치 2 가 "가" — tests/chars.test.ts).
// JS 문자열 위치(UTF-16)로 세면 이모지·확장 한자 같은 BMP 밖 글자 뒤에서 rhwp 와 어긋나고, 자를 때 글자를 반쪽 낼 수 있다.
// find_text 범위·read_blocks 자르기·get_outline 미리보기·highlight 대상이 모두 이 단위를 쓴다.

/** 글자 수 */
export const charLength = (text: string): number => [...text].length;

/** start 글자부터 end 글자 앞까지 (end 를 빼면 끝까지) */
export const sliceChars = (text: string, start: number, end?: number): string => [...text].slice(start, end).join('');

/**
 * JS 문자열 위치(UTF-16) → 글자 위치 표. 표[i] = text.slice(0, i) 의 글자 수 (i = 0..text.length).
 * 한 번 훑어 만든다. 문자열 검색(indexOf) 결과를 글자 위치로 바꿀 때 쓴다
 */
export function charIndexes(text: string): number[] {
  const indexes: number[] = [];
  let chars = 0;
  for (const char of text) {
    for (let unit = 0; unit < char.length; unit += 1) indexes.push(chars);
    chars += 1;
  }
  indexes.push(chars);
  return indexes;
}

/** 글자 범위 [start, end) 를 text 로 바꾸기(replace_text 대상 하나) */
export interface CharEdit {
  start: number;
  end: number;
  text: string;
}

/**
 * 입력 전후를 비교해 바뀐 범위만 구한다(SPEC-006 글자 고치기): 앞뒤 같은 글자를 잘라 [start, end) 를 text 로.
 * 앞뒤 같은 글자를 건드리지 않아 그 부분 서식(굵게 등)이 남는다. 같으면 undefined. 위치는 글자 단위.
 * caret(입력칸 커서, after 안 글자 위치)을 주면 고친 글자가 커서 바로 앞에서 끝난다고 보고 뒤쪽부터 커서까지만 맞춘다 —
 * 같은 글자가 이어지는 곳("가가나" → "가나")에서 사람이 지운 쪽을 잡는다(누름틀 값 안/밖, 부분 서식이 갈린다)
 */
export function changedRange(before: string, after: string, caret?: number): CharEdit | undefined {
  const from = [...before];
  const to = [...after];
  const shorter = Math.min(from.length, to.length);
  if (caret === undefined) {
    // 앞에서 맞춘 글자는 뒤에서 다시 세지 않는다("aa" → "aaa" 는 끝에 넣기)
    const head = commonHead(from, to, shorter);
    return rangeOf(from, to, head, commonTail(from, to, shorter - head));
  }
  // 커서 뒤 글자는 그대로라 뒤쪽을 먼저 맞추되 커서를 넘지 않는다. 앞쪽은 남은 만큼만 맞추고,
  // 고친 뒤 커서를 옮겼으면(커서가 바뀐 자리 앞) 남은 뒤쪽을 마저 맞춘다
  const head = commonHead(from, to, shorter - commonTail(from, to, Math.min(shorter, Math.max(to.length - caret, 0))));
  return rangeOf(from, to, head, commonTail(from, to, shorter - head));
}

function commonHead(from: string[], to: string[], max: number): number {
  let head = 0;
  while (head < max && from[head] === to[head]) head += 1;
  return head;
}

function commonTail(from: string[], to: string[], max: number): number {
  let tail = 0;
  while (tail < max && from[from.length - 1 - tail] === to[to.length - 1 - tail]) tail += 1;
  return tail;
}

function rangeOf(from: string[], to: string[], head: number, tail: number): CharEdit | undefined {
  if (head === from.length && head === to.length) return undefined;
  return { start: head, end: from.length - tail, text: to.slice(head, to.length - tail).join('') };
}
