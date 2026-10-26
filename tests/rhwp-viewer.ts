// 테스트용 뷰어 요청 처리: 브라우저 뷰어처럼 rhwp 로 문서를 열고 블록을 뽑아 들고 있다가 요청에 답한다.
// 렌더링은 하지 않는다. Node 의 글자 폭 근사 때문에 쪽 나눔은 브라우저와 다를 수 있다(ADR 001).
import { HwpDocument } from '@rhwp/core';
import { blockPositionSchema, type Block } from '../src/core/block-schema.ts';
import { extractBlocks } from '../src/core/blocks.ts';
import { findInBlocks } from '../src/core/find-text.ts';
import { initRhwpForNode } from '../src/core/rhwp-node.ts';
import type { RequestMessage } from '../src/shared/protocol.ts';

export function rhwpViewerHandler(): (request: RequestMessage) => unknown {
  initRhwpForNode();
  let blocks: Block[] | undefined;
  const opened = () => {
    if (blocks === undefined) throw new Error('뷰어에 열린 문서가 없습니다');
    return blocks;
  };
  return (request) => {
    switch (request.method) {
      case 'load_document': {
        const doc = new HwpDocument(new Uint8Array(Buffer.from(request.params.data, 'base64')));
        blocks = extractBlocks(doc);
        const pageCount = doc.pageCount();
        doc.free();
        return { pageCount, blocks: blocks.map((block) => blockPositionSchema.parse(block)) };
      }
      case 'get_blocks':
        return opened();
      case 'find_text':
        return findInBlocks(opened(), request.params.query);
    }
  };
}
