import { describe, expect, it } from 'vitest';
import { changedRange, charIndexes, charLength, sliceChars } from '../src/core/chars.ts';
import { createBlankDocument } from '../src/core/rhwp-node.ts';

describe('SPEC-001 블록 안 글자 위치 단위', () => {
  it('rhwp 의 글자 위치는 유니코드 글자 단위다(BMP 밖 글자도 한 글자)', () => {
    const doc = createBlankDocument();
    doc.insertText(0, 0, 0, '𠀀😀가나');

    expect(doc.getParagraphLength(0, 0)).toBe(4);
    expect(charLength('𠀀😀가나')).toBe(4);
    expect(doc.getTextRange(0, 0, 2, 1)).toBe('가');
  });

  it('글자 단위로 자르고, 문자열 위치를 글자 위치로 바꾼다(BMP 밖 글자를 반쪽 내지 않는다)', () => {
    expect(sliceChars('𠀀😀가나', 1, 3)).toBe('😀가');
    expect(sliceChars('𠀀😀가나', 2)).toBe('가나');
    // JS 문자열 위치 0..6 → 글자 위치 (𠀀·😀 는 UTF-16 두 칸)
    expect(charIndexes('𠀀😀가나')).toEqual([0, 0, 1, 1, 2, 3, 4]);
  });
});

describe('SPEC-006 입력 전후를 비교해 바뀐 범위만 구한다', () => {
  it('앞뒤 같은 글자를 잘라 가운데 바뀐 범위와 새 글자를 돌려준다', () => {
    expect(changedRange('회신 기한: 2026. 11. 14.(금)', '회신 기한: 2026. 11. 7.(금)')).toEqual({ start: 17, end: 19, text: '7' });
  });

  it('넣기만 했으면 빈 범위, 지우기만 했으면 빈 글자다', () => {
    expect(changedRange('가나다', '가나라다')).toEqual({ start: 2, end: 2, text: '라' });
    expect(changedRange('가나다', '가다')).toEqual({ start: 1, end: 2, text: '' });
  });

  it('같은 글자가 이어져도 앞에서 맞춘 글자를 뒤에서 다시 세지 않는다', () => {
    expect(changedRange('aa', 'aaa')).toEqual({ start: 2, end: 2, text: 'a' });
    expect(changedRange('aaa', 'a')).toEqual({ start: 1, end: 3, text: '' });
  });

  it('글자가 같으면 바뀐 범위가 없다', () => {
    expect(changedRange('가나다', '가나다')).toBeUndefined();
    expect(changedRange('', '')).toBeUndefined();
  });

  it('위치는 유니코드 글자 단위다(BMP 밖 글자를 반쪽 내지 않는다)', () => {
    // 😀(U+1F600)과 😁(U+1F601)은 UTF-16 앞 칸이 같다
    expect(changedRange('𠀀😀가', '𠀀😁가')).toEqual({ start: 1, end: 2, text: '😁' });
  });

  it('입력칸 커서(적용 직전 글자 위치)를 주면 같은 글자가 이어져도 사람이 고친 자리로 잡는다', () => {
    // "가가나" 의 첫 "가" 를 지우면 커서는 0, 둘째 "가" 를 지우면 1
    expect(changedRange('가가나', '가나', 0)).toEqual({ start: 0, end: 1, text: '' });
    expect(changedRange('가가나', '가나', 1)).toEqual({ start: 1, end: 2, text: '' });
    // "aa" 맨 앞에 "a" 를 넣으면 커서는 1
    expect(changedRange('aa', 'aaa', 1)).toEqual({ start: 0, end: 0, text: 'a' });
    expect(changedRange('aa', 'aaa', 3)).toEqual({ start: 2, end: 2, text: 'a' });
  });

  it('커서가 바뀐 자리 밖이어도(고친 뒤 커서를 옮김) 바뀐 범위는 맞는 글자를 만든다', () => {
    expect(changedRange('가나다', '가라다', 0)).toEqual({ start: 1, end: 2, text: '라' });
    expect(changedRange('가나다', '가라다', 3)).toEqual({ start: 1, end: 2, text: '라' });
  });

  it('빈 글자를 채우거나 모두 지울 수 있다', () => {
    expect(changedRange('', '새 글자')).toEqual({ start: 0, end: 0, text: '새 글자' });
    expect(changedRange('지울 글자', '')).toEqual({ start: 0, end: 5, text: '' });
  });
});
