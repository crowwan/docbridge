import { HwpDocument } from '@rhwp/core';
import { describe, expect, it } from 'vitest';
import { blockPositionSchema } from '../src/core/block-schema.ts';
import { extractBlocks } from '../src/core/blocks.ts';
import { replaceParagraphText } from '../src/core/edits.ts';
import { exportForSave } from '../src/core/hwpx-export.ts';
import { openFixture } from './fixtures.ts';

/** 글자가 있는 첫 본문 문단 */
function firstTextParagraph(doc: HwpDocument) {
  const block = extractBlocks(doc).find((b) => b.kind === 'paragraph' && b.text.length > 0);
  if (block === undefined || block.kind !== 'paragraph') throw new Error('글자 있는 문단이 없습니다');
  return block;
}

describe('SPEC-002 저장 전 검증 (뷰어 export_hwpx)', () => {
  it('편집한 문서를 내보내 다시 열어 같으면 HWPX 바이트(base64)와 지금 블록 위치를 준다', () => {
    const doc = openFixture('notice.hwpx');
    const target = firstTextParagraph(doc);
    replaceParagraphText(doc, target.section, target.paragraph, '고친 제목');

    const result = exportForSave(doc);

    if (!result.verified) throw new Error('검증에 실패했습니다');
    const reopened = new HwpDocument(new Uint8Array(Buffer.from(result.data, 'base64')));
    expect(reopened.getTextRange(target.section, target.paragraph, 0, 5)).toBe('고친 제목');
    expect(result.byteLength).toBe(Buffer.from(result.data, 'base64').length);
    expect(result.blocks).toHaveLength(extractBlocks(doc).length);
    expect(result.losses).toEqual([]);
  });

  it('다시 연 문서의 블록 글자가 다르면 바이트 없이 달라진 블록 위치를 준다', () => {
    const doc = openFixture('notice.hwpx');
    const target = firstTextParagraph(doc);
    const unedited = doc.exportHwpx();
    replaceParagraphText(doc, target.section, target.paragraph, '고친 제목');

    // 내보내기가 편집을 잃은 것처럼: 편집 전 바이트를 다시 연다
    const result = exportForSave(doc, { reopen: () => new HwpDocument(unedited) });

    const blocks = extractBlocks(doc);
    const edited = blocks.findIndex((b) => b.kind === 'paragraph' && b.section === target.section && b.paragraph === target.paragraph);
    expect(result).toEqual({
      verified: false,
      blocks: blocks.map((block) => blockPositionSchema.parse(block)),
      different: [edited],
      extraBlocks: 0,
      losses: [],
    });
  });

  it('내보낸 HWPX 를 다시 열지 못하면 바이트 없이 그 이유를 준다', () => {
    const doc = openFixture('notice.hwpx');

    const result = exportForSave(doc, {
      reopen: () => {
        throw new Error('압축을 풀 수 없습니다');
      },
    });

    expect(result).toMatchObject({ verified: false, reopenError: '압축을 풀 수 없습니다' });
    expect(result).not.toHaveProperty('data');
  });

  it('내보낸 파일이 크기 상한을 넘으면 오류로 알린다', () => {
    const doc = openFixture('notice.hwpx');

    expect(() => exportForSave(doc, { maxBytes: 1024 })).toThrow(/^저장할 문서가 너무 큽니다\(\d+MB\)\. \d+MB 까지 저장할 수 있습니다\.$/);
  });
});
