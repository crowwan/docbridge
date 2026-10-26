// 테스트용 문서를 @rhwp/core 편집 API 로 만든다.
// 내용은 모두 지어낸 것이고 개인정보가 없다. 실행: node scripts/make-fixtures.ts
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { HwpDocument } from '@rhwp/core';
import { createBlankDocument } from '../src/core/rhwp-node.ts';

const SECTION = 0;

type HeadType = 'None' | 'Number' | 'Outline';

interface ParagraphOptions {
  head?: HeadType;
  level?: number;
  bold?: boolean;
  fontSize?: number;
  align?: 'left' | 'center' | 'right' | 'justify';
}

// 빈 문서 끝에 문단·표·누름틀을 차례로 붙이는 도우미.
// rhwp 는 문단을 나눌 때 앞 문단 모양을 물려주므로, 문단마다 번호 종류를 다시 지정한다.
class DocumentWriter {
  readonly doc: HwpDocument;
  private lastParagraph = 0;
  // 표를 만든 뒤처럼 비어 있는 마지막 문단을 다음 문단으로 다시 쓸 수 있는지
  private reuseLast = true;
  private numberingId = 0;
  // 글자 모양과 누름틀은 문단을 모두 쓴 뒤 넣는다. 문단을 나누면 끝 글자 모양이 새 문단으로 넘어가고,
  // 누름틀을 먼저 넣으면 다음 문단을 나눌 때 뒤 글자가 누름틀 안으로 들어가기 때문이다.
  private pendingFields: Array<{ paragraph: number; guide: string; name: string }> = [];
  private pendingCharFormats: Array<{ paragraph: number; length: number; props: string }> = [];

  constructor() {
    this.doc = createBlankDocument();
  }

  useNumbering(levelFormats: string[], numberFormats: number[]): void {
    this.numberingId = this.doc.createNumbering(
      JSON.stringify({ levelFormats, numberFormats, startNumber: 1 }),
    );
  }

  paragraph(text: string, options: ParagraphOptions = {}): number {
    const index = this.nextParagraph();
    if (text.length > 0) this.doc.insertText(SECTION, index, 0, text);
    const head = options.head ?? 'None';
    this.doc.applyParaFormat(
      SECTION,
      index,
      JSON.stringify({
        headType: head,
        paraLevel: options.level ?? 0,
        ...(head === 'Number' ? { numberingId: this.numberingId } : {}),
        alignment: options.align ?? 'justify',
      }),
    );
    if (text.length > 0 && (options.bold === true || options.fontSize !== undefined)) {
      const props = { bold: options.bold ?? false, ...(options.fontSize ? { fontSize: options.fontSize } : {}) };
      this.pendingCharFormats.push({ paragraph: index, length: [...text].length, props: JSON.stringify(props) });
    }
    return index;
  }

  field(paragraph: number, guide: string, name: string): void {
    this.pendingFields.push({ paragraph, guide, name });
  }

  finish(): HwpDocument {
    for (const { paragraph, length, props } of this.pendingCharFormats) {
      this.doc.applyCharFormat(SECTION, paragraph, 0, length, props);
    }
    for (const { paragraph, guide, name } of this.pendingFields) {
      const offset = this.doc.getParagraphLength(SECTION, paragraph);
      this.doc.insertClickHereField(SECTION, paragraph, offset, guide, '', name, true);
    }
    this.pendingFields = [];
    this.pendingCharFormats = [];
    return this.doc;
  }

  table(rows: string[][]): void {
    const anchor = this.paragraph('');
    const rowCount = rows.length;
    const colCount = rows[0]?.length ?? 0;
    this.doc.createTable(SECTION, anchor, 0, rowCount, colCount);
    rows.forEach((row, r) => {
      row.forEach((text, c) => {
        if (text.length > 0) {
          this.doc.insertTextInCell(SECTION, anchor, 0, r * colCount + c, 0, 0, text);
        }
      });
    });
    // 표를 만들면 뒤에 빈 문단이 하나 생긴다. 다음 문단은 거기에 쓴다.
    this.lastParagraph = this.doc.getParagraphCount(SECTION) - 1;
    this.reuseLast = true;
  }

  private nextParagraph(): number {
    if (this.reuseLast) {
      this.reuseLast = false;
      return this.lastParagraph;
    }
    const end = this.doc.getParagraphLength(SECTION, this.lastParagraph);
    this.doc.splitParagraph(SECTION, this.lastParagraph, end);
    this.lastParagraph += 1;
    return this.lastParagraph;
  }
}

// 번호 모양: 1단계 "1.", 2단계 "가."
const GONGMUN_NUMBERING: [string[], number[]] = [['^1.', '^2.', '^3)'], [0, 8, 0]];

function buildNotice(): HwpDocument {
  const w = new DocumentWriter();
  w.useNumbering(...GONGMUN_NUMBERING);
  w.paragraph('가나다구청', { align: 'center', bold: true, fontSize: 2000 });
  const to = w.paragraph('수신  ');
  w.field(to, '받는 곳을 넣으세요', '수신');
  w.paragraph('(경유)');
  w.paragraph('제목  2026년 하반기 주민 안전교육 일정 안내');
  w.paragraph('');
  w.paragraph('관련: 가나다구청 안전총괄과-1234(2026. 9. 1.)', { head: 'Number', level: 0 });
  w.paragraph('하반기 주민 안전교육을 아래와 같이 실시하오니 각 동 주민센터에서는 주민들이 참여할 수 있도록 안내하여 주시기 바랍니다.', { head: 'Number', level: 0 });
  w.paragraph('교육 대상: 관내 주민 누구나', { head: 'Number', level: 1 });
  w.paragraph('교육 내용: 화재 대피 요령, 심폐소생술 실습', { head: 'Number', level: 1 });
  w.paragraph('신청 방법: 동 주민센터 방문 또는 전화 신청', { head: 'Number', level: 1 });
  w.paragraph('회신 기한: 2026. 11. 14.(금)까지 참석 인원을 회신하여 주시기 바랍니다.', { head: 'Number', level: 0 });
  w.table([
    ['구분', '일정', '장소'],
    ['1회차', '11. 20.(목) 14:00', '구민회관 대강당'],
    ['2회차', '11. 27.(목) 14:00', '구민회관 소강당'],
  ]);
  w.paragraph('붙임  교육 신청서 1부.  끝.');
  w.paragraph('');
  w.paragraph('가나다구청장', { align: 'center', bold: true, fontSize: 1800 });
  return w.finish();
}

function buildReport(): HwpDocument {
  const w = new DocumentWriter();
  w.paragraph('2026년 공공도서관 이용 현황 보고', { align: 'center', bold: true, fontSize: 1800 });
  w.paragraph('');
  const sections: Array<[string, string[]]> = [
    ['개요', ['이 보고서는 관내 공공도서관 다섯 곳의 2026년 1~3분기 이용 현황을 정리한 것이다.', '대출 권수, 방문자 수, 프로그램 참여 인원을 분기별로 비교하였다.']],
    ['이용 현황', ['3분기 방문자는 전 분기보다 8% 늘었고, 대출 권수는 4% 늘었다.', '어린이 열람실 이용이 가장 크게 늘었으며, 방학 기간 프로그램의 영향으로 보인다.']],
    ['분기별 비교', ['아래 표는 분기별 주요 지표이다. 단위는 천 명, 천 권이다.']],
    ['개선 과제', ['주말 운영 시간을 한 시간 늘리는 방안을 검토한다.', '전자책 대출 안내를 강화하여 비대면 이용을 늘린다.', '노후 열람석 교체 예산을 내년도 본예산에 반영한다.']],
    ['향후 계획', ['4분기 실적을 더해 연간 보고서를 2027년 1월에 낸다.', '이용자 만족도 조사를 11월 중에 실시한다.']],
  ];
  for (const [heading, body] of sections) {
    w.paragraph(heading, { head: 'Outline', level: 0, bold: true });
    for (const sentence of body) {
      w.paragraph(sentence, { head: 'Outline', level: 1 });
      // 쪽을 넘기도록 설명 문단을 덧붙인다.
      w.paragraph(`${sentence} 세부 내용은 붙임 자료를 참고한다. 담당 부서는 분기마다 같은 기준으로 자료를 모아 비교할 수 있게 한다.`);
    }
    if (heading === '분기별 비교') {
      w.table([
        ['지표', '1분기', '2분기', '3분기'],
        ['방문자', '412', '398', '430'],
        ['대출 권수', '286', '279', '290'],
        ['프로그램 참여', '12', '15', '21'],
      ]);
    }
  }
  for (let i = 1; i <= 12; i += 1) {
    w.paragraph(`참고 ${i}. 도서관별 세부 수치는 분기 보고서 원자료와 같다. 이 문단은 여러 쪽 문서의 렌더링을 확인하려고 넣었다.`);
  }
  return w.finish();
}

function buildApplication(): HwpDocument {
  const w = new DocumentWriter();
  w.paragraph('주민 안전교육 참가 신청서', { align: 'center', bold: true, fontSize: 2000 });
  w.paragraph('');
  w.table([
    ['성명', ''],
    ['생년월일', ''],
    ['연락처', ''],
    ['희망 회차', '1회차 / 2회차'],
  ]);
  w.paragraph('위와 같이 주민 안전교육 참가를 신청합니다.');
  const date = w.paragraph('신청일  ');
  w.field(date, '신청일을 넣으세요', '신청일');
  const name = w.paragraph('신청인  ', { align: 'right' });
  w.field(name, '이름을 넣으세요', '신청인');
  w.paragraph('가나다구청장 귀하', { align: 'center', bold: true });
  return w.finish();
}

const fixturesDir = fileURLToPath(new URL('../fixtures/', import.meta.url));
const notice = buildNotice();
writeFileSync(`${fixturesDir}notice.hwpx`, notice.exportHwpx());
writeFileSync(`${fixturesDir}notice.hwp`, notice.exportHwp());
writeFileSync(`${fixturesDir}report.hwpx`, buildReport().exportHwpx());
writeFileSync(`${fixturesDir}application.hwpx`, buildApplication().exportHwpx());
process.stderr.write('fixtures 생성 완료\n');
