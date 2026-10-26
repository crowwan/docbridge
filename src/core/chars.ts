// 블록 안 글자 위치의 단위: 유니코드 글자(code point).
// rhwp 의 글자 위치(getParagraphLength·getTextRange·getSelectionRects 등)가 이 단위다
// (빈 문서에 "𠀀😀가나" 를 넣으면 길이 4, 위치 2 가 "가" — tests/chars.test.ts).
// JS 문자열 위치(UTF-16)로 세면 이모지·확장 한자 같은 BMP 밖 글자 뒤에서 rhwp 와 어긋나고, 자를 때 글자를 반쪽 낼 수 있다.
// find_text 범위·read_blocks 자르기·get_outline 미리보기·highlight 대상이 모두 이 단위를 쓴다.

/** 글자 수 */
export const charLength = (text: string): number => [...text].length;

/** start 글자부터 end 글자 앞까지 (end 를 빼면 끝까지) */
export const sliceChars = (text: string, start: number, end?: number): string => [...text].slice(start, end).join('');

/** text 안에서 query 와 일치하는 곳을 from 글자부터 찾는다. 글자 위치, 없으면 -1 */
export function indexOfChars(text: string, query: string, from = 0): number {
  const at = text.indexOf(query, sliceChars(text, 0, from).length);
  return at === -1 ? -1 : charLength(text.slice(0, at));
}
