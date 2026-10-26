import { describe, expect, it } from 'vitest';
import { errorMessage } from '../src/shared/errors.ts';

describe('SPEC-001 오류 문구', () => {
  it('Error 면 메시지만, 아니면 문자열로 돌려준다', () => {
    expect(errorMessage(new Error('손상된 파일입니다'))).toBe('손상된 파일입니다');
    expect(errorMessage('문자열 오류')).toBe('문자열 오류');
    expect(errorMessage(42)).toBe('42');
  });
});
