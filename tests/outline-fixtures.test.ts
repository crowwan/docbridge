// rhwp 버전을 올릴 때 블록 추출 결과가 바뀌었는지 보는 회귀 세트(ADR 001).
// fixture 마다 get_outline 결과(전체)를 tests/outline/<파일>.json 과 비교한다. 바뀌면 diff 로 보인다.
// 일부러 바꾼 거라면 `npx vitest run tests/outline-fixtures.test.ts -u` 로 다시 쓰고 diff 를 PR 에서 본다.
// 쪽 번호는 Node 의 글자 폭 근사 기준이라 브라우저 뷰어와 다를 수 있다.
import { describe, expect, it } from 'vitest';
import { BlockIdTable } from '../src/core/block-ids.ts';
import { extractBlocks } from '../src/core/blocks.ts';
import { outline } from '../src/server/reading.ts';
import { openFixture } from './fixtures.ts';

const FIXTURES = ['notice.hwpx', 'notice.hwp', 'report.hwpx', 'application.hwpx', 'outline-demo.hwpx', 'sections.hwpx'];

describe('SPEC-001 fixture 별 get_outline 기대값 (rhwp 회귀)', () => {
  it.each(FIXTURES)('%s 의 get_outline 결과가 기대 JSON 과 같다', async (fixture) => {
    const blocks = extractBlocks(openFixture(fixture));
    const labeled = BlockIdTable.assign(blocks)
      .label(blocks)
      .flatMap(({ id, block }) => (id === undefined ? [] : [{ id, block }]));

    await expect(`${JSON.stringify(outline(labeled), null, 2)}\n`).toMatchFileSnapshot(`./outline/${fixture}.json`);
  });
});
