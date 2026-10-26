import { describe, expect, it } from 'vitest';
import { charLength, indexOfChars, sliceChars } from '../src/core/chars.ts';
import { createBlankDocument } from '../src/core/rhwp-node.ts';

describe('SPEC-001 블록 안 글자 위치 단위', () => {
  it('rhwp 의 글자 위치는 유니코드 글자 단위다(BMP 밖 글자도 한 글자)', () => {
    const doc = createBlankDocument();
    doc.insertText(0, 0, 0, '𠀀😀가나');

    expect(doc.getParagraphLength(0, 0)).toBe(4);
    expect(charLength('𠀀😀가나')).toBe(4);
    expect(doc.getTextRange(0, 0, 2, 1)).toBe('가');
  });

  it('글자 단위로 자르고 찾는다(BMP 밖 글자를 반쪽 내지 않는다)', () => {
    expect(sliceChars('𠀀😀가나', 1, 3)).toBe('😀가');
    expect(sliceChars('𠀀😀가나', 2)).toBe('가나');
    expect(indexOfChars('𠀀😀가나가', '가')).toBe(2);
    expect(indexOfChars('𠀀😀가나가', '가', 3)).toBe(4);
    expect(indexOfChars('𠀀😀가나', '다')).toBe(-1);
  });
});
