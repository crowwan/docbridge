import { describe, expect, it } from 'vitest';
import { DEFAULT_PORT, portFromEnv } from '../src/server/port.ts';

describe('SPEC-001 뷰어 서버 포트 설정 (DOCBRIDGE_PORT)', () => {
  it.each([undefined, '', '  '])('값이 없거나 비어 있으면(%j) 기본 포트 7790 을 쓴다', (value) => {
    expect(portFromEnv(value)).toBe(DEFAULT_PORT);
    expect(DEFAULT_PORT).toBe(7790);
  });

  it.each([
    ['8000', 8000],
    ['1', 1],
    ['65535', 65535],
    ['0', 0],
  ])('포트 번호 %s 는 그대로 쓴다(0 은 빈 포트 아무거나)', (value, port) => {
    expect(portFromEnv(value)).toBe(port);
  });

  it.each(['abc', '70000', '65536', '-1', '1.5', '80a'])('숫자가 아니거나 범위 밖이면(%s) 분명한 오류로 시작하지 않는다', (value) => {
    expect(() => portFromEnv(value)).toThrow(`DOCBRIDGE_PORT 가 올바른 포트 번호가 아닙니다: ${value}`);
  });
});

describe('E2E 개발 서버 포트 설정 (DOCBRIDGE_E2E_PORT)', () => {
  it('값이 없거나 비어 있으면 그 변수의 기본 포트를 쓴다', () => {
    expect(portFromEnv(undefined, 'DOCBRIDGE_E2E_PORT', 7792)).toBe(7792);
    expect(portFromEnv('', 'DOCBRIDGE_E2E_PORT', 7792)).toBe(7792);
    expect(portFromEnv('7794', 'DOCBRIDGE_E2E_PORT', 7792)).toBe(7794);
  });

  it('숫자가 아니면 그 변수 이름으로 분명한 오류를 낸다', () => {
    expect(() => portFromEnv('abc', 'DOCBRIDGE_E2E_PORT', 7792)).toThrow('DOCBRIDGE_E2E_PORT 가 올바른 포트 번호가 아닙니다: abc');
  });
});
