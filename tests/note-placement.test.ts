import { describe, expect, it } from 'vitest';
import { notePlacement, textBoxes, type NoteSpace } from '../src/core/note-placement.ts';

// 쪽 크기·글자 줄은 notice.hwpx 실제 배치(줄 간격 약 21px, 글자 높이 약 13px)를 본떴다
const PAGE = { width: 794, height: 1123 };
const OPTIONS = { gap: 4, minMarginWidth: 160 };
const line = (y: number, x = 113, width = 560) => ({ x, y, width, height: 13 });

function space(textLines: ReturnType<typeof line>[], rightMargin = 0): NoteSpace {
  return { page: PAGE, rightMargin, textBoxes: textLines };
}

describe('SPEC-001 note 자리 (#51)', () => {
  it('첫 사각형 위 빈 공간에 들어가면 바로 위에 왼쪽 끝을 맞춘다', () => {
    const first = line(132, 332, 129);
    const placement = notePlacement(first, first, { width: 80, height: 28 }, space([first]), OPTIONS);
    expect(placement).toEqual({ side: 'above', x: 332, y: 132 - 4 - 28 });
  });

  it('앞 줄 글자와 겹치면 위에 두지 않고 쪽 오른쪽 바깥 여백에 첫 사각형 높이로 둔다', () => {
    const heading = line(260);
    const first = line(281);
    const placement = notePlacement(first, line(302), { width: 280, height: 68 }, space([heading, first], 400), OPTIONS);
    expect(placement).toEqual({ side: 'margin', x: PAGE.width + 4, y: 281, width: 280 });
  });

  it('앞 줄 글자가 note 가로 범위 밖이면 위에 둔다', () => {
    const shortHeading = line(260, 113, 40);
    const first = line(290, 400, 100);
    const placement = notePlacement(first, first, { width: 80, height: 20 }, space([shortHeading, first]), OPTIONS);
    expect(placement).toEqual({ side: 'above', x: 400, y: 290 - 4 - 20 });
  });

  it('바깥 여백이 note 보다 좁아도 최소 폭 이상이면 여백 폭에 맞춰 줄바꿈한다', () => {
    const first = line(281);
    const placement = notePlacement(first, first, { width: 280, height: 48 }, space([line(260), first], 200), OPTIONS);
    expect(placement).toEqual({ side: 'margin', x: PAGE.width + 4, y: 281, width: 200 - 8 });
  });

  it('위에도 바깥 여백에도 자리가 없으면 하이라이트 마지막 사각형 아래에 둔다', () => {
    const first = line(281);
    const last = line(302, 125, 205);
    const placement = notePlacement(first, last, { width: 280, height: 48 }, space([line(260), first, last], 100), OPTIONS);
    expect(placement).toEqual({ side: 'below', x: 113, y: 302 + 13 + 4 });
  });

  it('쪽 위쪽에 자리가 없으면(글자가 없어도) 위에 두지 않는다', () => {
    const first = line(10);
    const placement = notePlacement(first, first, { width: 80, height: 28 }, space([first], 0), OPTIONS);
    expect(placement.side).toBe('below');
  });

  it('위·아래에 둘 때 note 가 쪽 오른쪽 밖으로 나가지 않게 왼쪽으로 당긴다', () => {
    const first = line(200, 700, 80);
    const placement = notePlacement(first, first, { width: 200, height: 28 }, space([first]), OPTIONS);
    expect(placement).toEqual({ side: 'above', x: PAGE.width - 200, y: 200 - 4 - 28 });
  });
});

describe('SPEC-001 note 자리 — 쪽 글자 사각형', () => {
  it('글자 배치에서 빈 글자·공백만 있는 배치는 뺀다(빈 문단 배치가 단 폭 전체로 나온다)', () => {
    const run = (text: string, x: number) => ({ text, x, y: 10, w: 50, h: 13 });
    expect(textBoxes([run('제목', 0), run('', 60), run('  ', 120)])).toEqual([{ x: 0, y: 10, width: 50, height: 13 }]);
  });
});
