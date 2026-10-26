import { describe, expect, it } from 'vitest';
import { charIndexes, charLength, sliceChars } from '../src/core/chars.ts';
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
