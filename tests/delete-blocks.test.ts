// delete_blocks 의 문단 개체 검사(core/delete-blocks.ts bodyControls). rhwp 로는 구역이 둘 이상인 문서를 만들 수 없어
// (breakAtCursor 'section' 은 구역 정의만 넣고 구역 수는 1 그대로다, 저장해 다시 열어도 같다) getControls 등의 JSON 을 흉내 낸다.
// 모양은 여러 구역 한컴 문서에서 확인한 것: 본문은 목록 0 하나, para 는 구역을 이어 센 문서 전체 문단 번호(ADR 003, #41).
import { describe, expect, it } from 'vitest';
import { bodyControls } from '../src/core/delete-blocks.ts';
import { fieldTableIndex } from '../src/core/fields.ts';

const control = (ctrlId: string, userDesc: string, list: number, para: number) => ({ ctrlId, userDesc, list, para, pos: 0, controlIndex: 0 });

/** 구역 0 = 문단 3개, 구역 1 = 문단 3개. 구역 1 의 셋째 문단(문서 전체 5번)에 그림이 있다 */
function twoSectionDocument() {
  const paragraphCounts = [3, 3];
  const controls = [
    control('secd', '구역 정의', 0, 0),
    control('cold', '단 정의', 0, 0),
    control('secd', '구역 정의', 0, 3),
    control('cold', '단 정의', 0, 3),
    control('gso', '그림', 0, 5),
    control('', '', 7, 0), // 글상자·표 칸 안 목록은 본문이 아니다
  ];
  const textPositions = new Map([
    ['0:0', [0, 1]],
    ['1:0', [0, 1]],
    ['1:2', [0]],
  ]);
  return {
    getSectionCount: () => paragraphCounts.length,
    getParagraphCount: (section: number) => paragraphCounts[section] ?? 0,
    getControls: () => JSON.stringify(controls),
    getControlTextPositions: (section: number, paragraph: number) => JSON.stringify(textPositions.get(`${section}:${paragraph}`) ?? []),
  };
}

describe('SPEC-002 delete_blocks 여러 구역 문서 (#41)', () => {
  it('AC-3 둘째 구역 문단의 컨트롤을 문서 전체 문단 번호로 찾아, 개체가 없는 문단은 지울 수 있다고 본다', () => {
    const controlsAt = bodyControls(twoSectionDocument());

    expect(controlsAt({ section: 0, paragraph: 1 })).toEqual([]);
    expect(controlsAt({ section: 1, paragraph: 1 })).toEqual([]);
  });

  it('AC-3 둘째 구역 문단의 블록이 아닌 개체(그림)와 구역 정의는 그 구역 문단에서 찾는다', () => {
    const controlsAt = bodyControls(twoSectionDocument());

    expect(controlsAt({ section: 1, paragraph: 2 })?.map(({ userDesc }) => userDesc)).toEqual(['그림']);
    expect(controlsAt({ section: 1, paragraph: 0 })?.map(({ ctrlId }) => ctrlId)).toEqual(['secd', 'cold']);
    expect(controlsAt({ section: 0, paragraph: 2 })).toEqual([]);
  });

  it('구역 첫 문단에 구역 정의가 없으면(문단 번호 맞추기가 어긋남) 모든 문단을 확인하지 못한 것으로 본다(undefined)', () => {
    const document = twoSectionDocument();
    // 구역 1 이 문서 전체 2번 문단에서 시작한다고 하면 그 자리에 구역 정의가 없다
    const misaligned = bodyControls({ ...document, getParagraphCount: (section: number) => [2, 4][section] ?? 0 });

    expect(misaligned({ section: 0, paragraph: 1 })).toBeUndefined();
    expect(misaligned({ section: 1, paragraph: 2 })).toBeUndefined();
  });

  it('컨트롤 목록과 문단의 컨트롤 글자 위치 수가 다르면 확인하지 못한 것으로 본다(undefined)', () => {
    const document = twoSectionDocument();
    const controlsAt = bodyControls({ ...document, getControlTextPositions: () => JSON.stringify([0, 1, 2]) });

    expect(controlsAt({ section: 1, paragraph: 2 })).toBeUndefined();
  });
});

describe('SPEC-002 누름틀이 든 표 판정 (#42)', () => {
  it('표 칸 단계로 시작하는 경로만 표 안이다. 글상자 컨트롤 번호가 표 컨트롤 번호와 같아도 표로 보지 않는다', () => {
    expect(fieldTableIndex([{ type: 'cell', controlIndex: 0, cellIndex: 2, paraIndex: 0 }])).toBe(0);
    expect(fieldTableIndex([{ type: 'textbox', controlIndex: 0 }])).toBeUndefined();
    expect(fieldTableIndex([])).toBeUndefined();
    expect(fieldTableIndex(undefined)).toBeUndefined();
  });
});
