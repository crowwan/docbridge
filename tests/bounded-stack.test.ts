import { describe, expect, it } from 'vitest';
import { BoundedStack } from '../src/core/bounded-stack.ts';

describe('SPEC-002 되돌리기 칸 (상한 있는 스택)', () => {
  it('상한을 넘으면 가장 옛 것을 빼서 돌려준다', () => {
    const stack = new BoundedStack<string>(2);

    expect(stack.push('가')).toEqual([]);
    expect(stack.push('나')).toEqual([]);
    expect(stack.push('다')).toEqual(['가']);
    expect(stack.size).toBe(2);
  });

  it('n 개를 최근 것부터 꺼내고, 있는 만큼만 꺼낸다', () => {
    const stack = new BoundedStack<string>(20);
    for (const item of ['가', '나', '다']) stack.push(item);

    expect(stack.take(2)).toEqual(['다', '나']);
    expect(stack.take(5)).toEqual(['가']);
    expect(stack.take(1)).toEqual([]);
  });

  it('비우면 남은 것을 모두 돌려준다', () => {
    const stack = new BoundedStack<string>(20);
    stack.push('가');
    stack.push('나');

    expect(stack.clear()).toEqual(['가', '나']);
    expect(stack.size).toBe(0);
  });
});
