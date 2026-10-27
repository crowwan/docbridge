// SPEC-002 기술 검증(#18): 한글 프로그램에서 열어 볼 HWPX 파일을 만든다(AC-13 수동 QA 재료).
// fixture 3개(공문·보고서·신청서)에 옮기기·바꾸기·칸/누름틀 채우기·문단 넣기를 하고 HWPX 로 내보낸다.
// 내보내기 전 검증(다시 열어 블록 비교)을 거치고, 쓴 파일을 rhwp 로 다시 열어 기대한 글자·번호가 있는지 본다.
// 실행: node scripts/make-hwp-check.ts [출력 폴더]   (기본 ~/Downloads/docbridge-hwp-check)
//       한컴 문서로도 보려면 DOCBRIDGE_REAL_GONGMUN=<한컴이 저장한 기안문 .hwpx> 를 준다(레포에 넣지 않는 로컬 파일)
// 결과물은 레포에 넣지 않는다.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HwpDocument } from '@rhwp/core';
import { BlockIdTable } from '../src/core/block-ids.ts';
import { extractBlocks, type Block } from '../src/core/blocks.ts';
import { charIndexes } from '../src/core/chars.ts';
import { EditHistory } from '../src/core/edit-history.ts';
import {
  insertParagraphNear,
  listFields,
  moveParagraphs,
  replaceCellText,
  replaceFieldText,
  replaceParagraphText,
} from '../src/core/edits.ts';
import { exportVerifiedHwpx } from '../src/core/hwpx-export.ts';
import { openDocumentFile } from '../src/core/rhwp-node.ts';
import { outline } from '../src/server/reading.ts';

const S = 0;
const outDir = process.argv[2] ?? join(homedir(), 'Downloads', 'docbridge-hwp-check');
const fixture = (name: string) => fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));

/** 문서 하나를 고치는 세션: id 표와 되돌리기 기록을 편집과 같이 움직인다(서버·뷰어가 할 일을 한 곳에서) */
class EditSession {
  readonly doc: HwpDocument;
  ids: BlockIdTable;
  readonly history: EditHistory<BlockIdTable>;
  readonly log: string[] = [];

  constructor(path: string) {
    this.doc = openDocumentFile(path);
    this.ids = BlockIdTable.assign(extractBlocks(this.doc));
    this.history = new EditHistory(this.doc);
  }

  labeled() {
    return this.ids.label(extractBlocks(this.doc)).flatMap(({ id, block }) => (id === undefined ? [] : [{ id, block }]));
  }

  /** 글자로 시작하는 문단 블록(앞 공백은 보지 않는다) */
  paragraph(startsWith: string): { id: string; block: Extract<Block, { kind: 'paragraph' }> } {
    for (const { id, block } of this.labeled()) {
      if (block.kind === 'paragraph' && block.text.trimStart().startsWith(startsWith)) return { id, block };
    }
    throw new Error(`"${startsWith}" 문단이 없습니다`);
  }

  table(): { id: string; block: Extract<Block, { kind: 'table' }> } {
    for (const { id, block } of this.labeled()) if (block.kind === 'table') return { id, block };
    throw new Error('표가 없습니다');
  }

  move(firstText: string, lastText: string, beforeText: string): void {
    const first = this.paragraph(firstText).block.paragraph;
    const last = this.paragraph(lastText).block.paragraph;
    const before = this.paragraph(beforeText).block.paragraph;
    const result = this.history.apply('옮기기', this.ids.clone(), () => moveParagraphs(this.doc, S, first, last + 1, before), (r) => r.ok);
    if (!result.ok) throw new Error(`옮기지 못했습니다: ${JSON.stringify(result.rejected)}`);
    this.ids.paragraphsMoved(S, first, last + 1, before);
    this.log.push(`옮기기: "${firstText}"~"${lastText}" 문단을 "${beforeText}" 문단 앞으로`);
  }

  replace(paragraphText: string, from: string, to: string): void {
    const { block } = this.paragraph(paragraphText);
    const utf16 = block.text.indexOf(from);
    if (utf16 < 0) throw new Error(`"${from}" 글자가 없습니다`);
    const index = charIndexes(block.text);
    const start = index[utf16] ?? 0;
    const end = index[utf16 + from.length] ?? start;
    this.history.apply('바꾸기', this.ids.clone(), () => replaceParagraphText(this.doc, S, block.paragraph, to, start, end));
    this.log.push(`글자 바꾸기: "${from}" → "${to}"`);
  }

  cell(row: number, col: number, text: string): void {
    const { block } = this.table();
    const cellIndex = block.cells.findIndex((c) => c.row === row && c.col === col);
    const before = block.cells[cellIndex]?.text ?? '';
    const address = { section: S, paragraph: block.paragraph, controlIndex: block.controlIndex, cellIndex };
    this.history.apply('칸 채우기', this.ids.clone(), () => replaceCellText(this.doc, address, text));
    this.log.push(`표 칸(${row},${col}) "${before}" → "${text}"`);
  }

  field(name: string, text: string): void {
    const field = listFields(this.doc).find((f) => f.name === name);
    if (field === undefined) throw new Error(`누름틀 ${name} 이 없습니다`);
    this.history.apply('누름틀 채우기', this.ids.clone(), () => replaceFieldText(this.doc, field.fieldId, text));
    this.log.push(`누름틀 "${name}" "${field.value}" → "${text}"`);
  }

  insertAfter(paragraphText: string, text: string): void {
    const { block } = this.paragraph(paragraphText);
    const at = this.history.apply('넣기', this.ids.clone(), () => insertParagraphNear(this.doc, S, block.paragraph, 'after', text));
    this.ids.paragraphInserted(S, at);
    this.log.push(`문단 넣기: "${paragraphText}" 문단 뒤에 "${text}"`);
  }
}

interface CheckFile {
  file: string;
  source: string;
  edit: (session: EditSession) => void;
  /** 다시 연 파일에 이 순서대로 있어야 하는 블록 글자(번호 포함, 앞 공백 무시, 일부만 줘도 된다). 누름틀은 "이름=값" */
  expect: string[];
  /** 한글에서 볼 것 */
  look: string[];
}

const files: CheckFile[] = [
  {
    file: '01-공문-수정.hwpx',
    source: fixture('notice.hwpx'),
    edit: (s) => {
      s.move('회신 기한', '회신 기한', '관련:');
      s.replace('회신 기한', '2026. 11. 14.(금)', '2026. 11. 7.(금)');
      s.cell(1, 1, '11. 21.(금) 14:00');
      s.field('수신', '각 동 주민센터장');
      s.insertAfter('신청 방법', '준비물: 편한 복장과 운동화');
    },
    expect: ['1. 회신 기한: 2026. 11. 7.(금)', '2. 관련:', '3. 하반기', '라. 준비물: 편한 복장과 운동화'],
    look: [
      '번호: "회신 기한" 이 1. 로 맨 위, 그 아래 2. 관련, 3. 하반기 … 순서',
      '"하반기" 아래 가.·나.·다.·라. 네 개, 라. 가 "준비물: 편한 복장과 운동화" (다른 항목과 같은 들여쓰기·글꼴)',
      '회신 기한 날짜가 "2026. 11. 7.(금)"',
      '표 1회차 일정 칸이 "11. 21.(금) 14:00"',
      '수신 누름틀 값이 "각 동 주민센터장" (누름틀로 남아 있는지: 클릭하면 누름틀 표시)',
    ],
  },
  {
    file: '02-보고서-수정.hwpx',
    source: fixture('report.hwpx'),
    edit: (s) => {
      s.move('개선 과제', '노후 열람석 교체 예산을 내년도 본예산에 반영한다. 세부', '이용 현황');
      s.replace('3분기 방문자는', '8% 늘었고', '9% 늘었고');
      s.cell(1, 3, '460');
    },
    expect: ['1. 개요', '2. 개선 과제', '가. 주말 운영', '3. 이용 현황', '가. 3분기 방문자는 전 분기보다 9% 늘었고', '4. 분기별 비교', '5. 향후 계획'],
    look: [
      '개요 번호: 1. 개요, 2. 개선 과제, 3. 이용 현황, 4. 분기별 비교, 5. 향후 계획 순서',
      '"개선 과제" 아래 가.·나.·다. 와 설명 문단이 함께 옮겨졌는지(굵기·들여쓰기 그대로)',
      '"3분기 방문자는 전 분기보다 9% 늘었고" (두 군데 중 첫 번째 가. 문단)',
      '표 "방문자" 행 3분기 칸이 "460"',
    ],
  },
  {
    file: '03-신청서-수정.hwpx',
    source: fixture('application.hwpx'),
    edit: (s) => {
      s.cell(0, 1, '홍길동');
      s.cell(1, 1, '1990. 1. 1.');
      s.cell(2, 1, '010-1234-5678');
      s.cell(3, 1, '1회차');
      s.field('신청일', '2026. 11. 3.');
      s.field('신청인', '홍길동');
      s.move('신청인', '신청인', '신청일');
    },
    expect: ['성명 | 홍길동 | 생년월일 | 1990. 1. 1. | 연락처 | 010-1234-5678 | 희망 회차 | 1회차', '신청인  홍길동', '신청인=홍길동', '신청일  2026. 11. 3.', '신청일=2026. 11. 3.'],
    look: [
      '표 값 칸: 성명 "홍길동", 생년월일 "1990. 1. 1.", 연락처 "010-1234-5678", 희망 회차 "1회차"',
      '"신청인  홍길동" 이 "신청일  2026. 11. 3." 보다 위 (오른쪽 정렬 그대로)',
      '두 누름틀이 누름틀로 남아 있는지(클릭하면 누름틀 표시), 값 글꼴이 앞 글자와 같은지',
    ],
  },
];

const realGongmun = process.env.DOCBRIDGE_REAL_GONGMUN;
if (realGongmun !== undefined && realGongmun.length > 0) {
  files.push({
    file: '04-선택-한컴기안문-수정.hwpx',
    source: realGongmun,
    edit: (s) => {
      s.move('나.', '나.', '가.');
      s.field('제목', `${listFields(s.doc).find((f) => f.name === '제목')?.value ?? ''}(수정)`);
      s.replace('라.', '지상5층', '지상6층');
    },
    expect: ['제목=고시원 안전시설 등 설치신고서 접수에 따른 건축법령 확인요청(수정)', '나. 영 업 주', '가. 대상(업종)', '라. 건물구조 : 철근콘크리트구조 지상6층'],
    look: [
      '한컴오피스가 저장한 실제 기안문(rhwp 공개 샘플). 위 3개는 rhwp 가 만든 문서라 이것도 같이 보면 좋다',
      '"나. 영 업 주" 가 "가. 대상(업종)" 위로 (직접 입력한 번호라 "나." 글자는 그대로 — 스펙 AC-6 경고 대상)',
      '머리 표의 제목 끝에 "(수정)" (표 안 누름틀, 글자 모양 그대로)',
      '"라. 건물구조" 의 "지상6층"',
    ],
  });
}

/** get_outline 결과를 번호·앞 글자 한 줄씩으로 */
const outlineLines = (session: EditSession) =>
  outline(session.labeled()).blocks.map((b) => `${b.id} ${b.kind}${b.number ? ` ${b.number}` : ''} ${b.name ?? ''}${b.text}`.trim());

const blockLine = (block: Block): string => {
  switch (block.kind) {
    case 'paragraph':
      return `${block.number ? `${block.number} ` : ''}${block.text}`;
    case 'table':
      return block.cells.map((c) => c.text).join(' | ');
    case 'field':
      return `${block.name}=${block.value}`;
  }
};

mkdirSync(outDir, { recursive: true });
mkdirSync(join(outDir, '기준-편집없음'), { recursive: true });
const readme: string[] = [
  'docbridge 한글 확인용 파일 (SPEC-002 기술 검증 #18)',
  '',
  '각 파일을 한글 프로그램(맥 한글 또는 한글 Viewer)에서 열어 아래를 확인해 주세요.',
  '- 열 때 "손상", "변조", "복구" 같은 경고가 뜨는지 (뜨면 문구를 그대로 알려주세요)',
  '- 각 파일 "확인할 것" 의 내용·번호가 맞는지',
  '경고가 뜨면 "기준-편집없음" 폴더의 같은 번호 파일(편집 없이 rhwp 로 HWPX 저장만 한 것)도 열어 보고, 그것도 경고가 뜨는지 알려주세요.',
  '(편집 때문인지, rhwp HWPX 저장 자체 때문인지 가르는 용도)',
  '',
];

for (const check of files) {
  const baseline = openDocumentFile(check.source);
  const baseExport = exportVerifiedHwpx(baseline);
  writeFileSync(join(outDir, '기준-편집없음', check.file.replace('-수정', '-기준')), baseExport.bytes);

  const session = new EditSession(check.source);
  const before = outlineLines(session);
  check.edit(session);
  const after = outlineLines(session);
  const verified = exportVerifiedHwpx(session.doc);
  if (verified.different.length > 0) throw new Error(`${check.file}: 다시 연 문서와 블록이 다릅니다: ${verified.different.join(', ')}`);
  const path = join(outDir, check.file);
  writeFileSync(path, verified.bytes);

  // 쓴 파일을 다시 열어 기대한 블록이 있는지
  const reopened = extractBlocks(openDocumentFile(path)).map(blockLine);
  let cursor = 0;
  for (const want of check.expect) {
    const found = reopened.findIndex((line, i) => i >= cursor && line.trimStart().startsWith(want));
    if (found < 0) throw new Error(`${check.file}: 다시 연 파일에 "${want}" 가 (앞 블록 뒤에) 없습니다`);
    cursor = found + 1;
  }

  readme.push(`■ ${check.file}  (원본: ${check.source.includes('/fixtures/') ? `fixtures/${check.source.split('/').pop()}` : '로컬 한컴 문서'})`);
  readme.push('  바꾼 것:');
  for (const line of session.log) readme.push(`   - ${line}`);
  readme.push('  확인할 것:');
  for (const line of check.look) readme.push(`   - ${line}`);
  readme.push(`  rhwp 로 다시 열어 확인: 블록 ${reopened.length}개 같음, 손실 보고 ${verified.losses.length}건, 기대한 글자 ${check.expect.length}곳이 순서대로 있음`);
  readme.push('');

  console.log(`\n## ${check.file}\n${session.log.map((l) => `- ${l}`).join('\n')}`);
  console.log(`get_outline 전:\n${before.join('\n')}\nget_outline 후:\n${after.join('\n')}`);
  console.log(`검증: 다른 블록 ${verified.different.length}, 손실 ${verified.losses.length}, ${verified.bytes.length} bytes`);
}

writeFileSync(join(outDir, 'README.txt'), `${readme.join('\n')}\n`);
console.log(`\n${outDir} 에 ${files.length}개 + 기준 ${files.length}개 + README.txt`);
// readFileSync 는 쓴 파일 크기 확인용
for (const check of files) console.log(check.file, readFileSync(join(outDir, check.file)).length, 'bytes');
