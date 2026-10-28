import { describe, expect, it } from 'vitest';
import { mcpbBinEntry } from '../scripts/pack/manifest.ts';

describe('SPEC-004 mcpb CLI 진입 파일 찾기 (npm run pack)', () => {
  it('package.json 의 bin 이 문자열이면 그 경로를 쓴다', () => {
    expect(mcpbBinEntry({ name: '@anthropic-ai/mcpb', bin: 'dist/cli/cli.js' })).toBe('dist/cli/cli.js');
  });

  it('bin 이 명령 이름 → 경로 객체면 mcpb 명령의 경로를 쓴다', () => {
    // mcpb 가 다음 버전에서 bin 을 객체로 바꿔도 pack 이 멈추지 않게(#99)
    expect(mcpbBinEntry({ bin: { other: 'dist/other.js', mcpb: 'dist/cli/cli.js' } })).toBe('dist/cli/cli.js');
  });

  it('bin 객체에 mcpb 명령이 없거나 bin 이 없으면 무엇이 없는지 알리며 실패한다', () => {
    expect(() => mcpbBinEntry({ bin: { other: 'dist/other.js' } })).toThrow(/mcpb/);
    expect(() => mcpbBinEntry({ name: '@anthropic-ai/mcpb' })).toThrow(/bin/);
  });
});
