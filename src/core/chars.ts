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
