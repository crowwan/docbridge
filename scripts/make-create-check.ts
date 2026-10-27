// SPEC-003 기술 검증(#35): 한글 프로그램에서 열어 볼 "새로 만든" HWPX 파일을 만든다(AC-10 수동 QA 재료).
// 빈 문서(rhwp createBlankDocument)와 양식(fixture 본문을 비운 것)에 제목·개요 1~2단계·본문·3×2 표(머리글 포함)를 채워 HWPX 로 내보낸다.
// 내보내기 전 검증(다시 열어 블록 비교)을 거치고, 쓴 파일을 rhwp 로 다시 열어 get_outline 이 기대와 같은지 본다.
// 실행: node scripts/make-create-check.ts [출력 폴더]   (기본 ~/Downloads/docbridge-create-check)
//       한컴이 저장한 실제 양식으로도 보려면 DOCBRIDGE_CREATE_TEMPLATES=<a.hwpx,b.hwp> (레포에 넣지 않는 로컬 파일)
// 결과물은 레포에 넣지 않는다.
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HwpDocument } from '@rhwp/core';
import { BlockIdTable } from '../src/core/block-ids.ts';
import { extractBlocks } from '../src/core/blocks.ts';
import {
  applyParagraphStyle,
  clearTemplateBody,
  ensureTitleStyle,
  insertTableParagraph,
  styleIdByName,
  type ClearedBody,
} from '../src/core/create-document.ts';
import { insertParagraphNear, replaceParagraphText } from '../src/core/edits.ts';
import { exportVerifiedHwpx } from '../src/core/hwpx-export.ts';
import { createBlankDocument, openDocumentFile } from '../src/core/rhwp-node.ts';
import { outline } from '../src/server/reading.ts';

const S = 0;
const outDir = process.argv[2] ?? join(homedir(), 'Downloads', 'docbridge-create-check');
const fixture = (name: string) => fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));

/** 채울 내용: [글자, 스타일]. 표는 "기능" 개요 뒤에 넣는다 */
const TITLE = 'DocBridge 도입 제안서';
const BEFORE_TABLE: [string, string][] = [
  ['제안 배경', '개요 1'],
  ['공공기관·학교 문서의 상당수는 한글(HWP·HWPX)로 오간다.', '본문'],
  ['현황', '개요 2'],
  ['받은 문서를 묻고 고치려면 한글 프로그램을 따로 열어야 한다.', '본문'],
  ['문제', '개요 2'],
  ['주요 기능', '개요 1'],
];
const TABLE = {
  rows: 3,
  cols: 2,
  header: true,
  cells: [
    ['기능', '설명'],
    ['읽기·묻기', '문서를 블록으로 읽고 근거를 하이라이트한다'],
    ['말로 고치기', '글자·표·문단을 채팅으로 고친다\n저장 전에 다시 열어 비교한다'],
  ],
};
const AFTER_TABLE: [string, string][] = [
  ['표 아래 본문 문단.', '본문'],
  ['기대 효과', '개요 1'],
];

/** 다시 연 파일의 get_outline 이 이것과 같아야 한다(번호 + 글자, 표는 칸 글자) */
const EXPECTED = [
  `paragraph ${TITLE}`,
  'paragraph 1. 제안 배경',
  'paragraph 공공기관·학교 문서의 상당수는 한글(HWP·HWPX)로 오간다.',
  'paragraph 가. 현황',
  'paragraph 받은 문서를 묻고 고치려면 한글 프로그램을 따로 열어야 한다.',
  'paragraph 나. 문제',
  'paragraph 2. 주요 기능',
  'table 기능 | 설명 | 읽기·묻기 | 문서를 블록으로 읽고 근거를 하이라이트한다 | 말로 고치기 | 글자·표·문단을 채팅으로 고친다\n저장 전에 다시 열어 비교한다',
  'paragraph 표 아래 본문 문단.',
  'paragraph 3. 기대 효과',
];

interface CheckFile {
  file: string;
  source: string;
  /** 시작 문서를 만든다(빈 문서 또는 양식을 비운 것). 비운 결과가 있으면 돌려준다 */
  start: () => { doc: HwpDocument; cleared?: ClearedBody };
  /** 제목 문단 스타일: 제목(docbridge 가 더한 스타일) 또는 바탕글(제목 스타일 없이 — 한글 경고를 가를 때) */
  titleStyle: 'title' | 'normal';
  look: string[];
  /** false 면 번호는 양식 스타일을 따르므로 글자만 기대와 비교하고, rhwp 가 매긴 번호를 README 에 적는다(로컬 한컴 양식) */
  exactNumbers: boolean;
}

/** insert_paragraph(style) · insert_table 이 할 일을 차례로. 마지막 문단 번호를 돌려준다 */
function writeLines(doc: HwpDocument, after: number, lines: [string, string][]): number {
  let last = after;
  for (const [text, style] of lines) {
    last = insertParagraphNear(doc, S, last, 'after', text);
    applyParagraphStyle(doc, S, last, styleIdByName(doc, style));
  }
  return last;
}

function fill(doc: HwpDocument, titleStyle: CheckFile['titleStyle']): void {
  replaceParagraphText(doc, S, 0, TITLE);
  applyParagraphStyle(doc, S, 0, titleStyle === 'title' ? ensureTitleStyle(doc) : styleIdByName(doc, '바탕글'));
  // 구역 첫 문단 뒤로(양식에 남긴 머리말 문단 등이 있으면 그 앞이 아니라 첫 문단 바로 뒤부터)
  const beforeTable = writeLines(doc, 0, BEFORE_TABLE);
  const table = insertTableParagraph(doc, S, beforeTable, 'after', TABLE);
  writeLines(doc, table.paragraph, AFTER_TABLE);
}

function withHeaderFooter(path: string): HwpDocument {
  const doc = openDocumentFile(path);
  doc.createHeaderFooter(S, true, 0);
  doc.insertTextInHeaderFooter(S, true, 0, 0, 0, '가나다구청 · 머리말');
  doc.createHeaderFooter(S, false, 0);
  doc.insertTextInHeaderFooter(S, false, 0, 0, 0, '꼬리말 · 대외비');
  return doc;
}

const COMMON_LOOK = [
  '맨 위 "DocBridge 도입 제안서" 가 가운데 정렬·크고 굵게 (스타일 "제목": 서식 → 스타일 목록에서 확인)',
  '개요 번호: 1. 제안 배경 / 가. 현황 / 나. 문제 / 2. 주요 기능 / 3. 기대 효과 (스타일 "개요 1"·"개요 2", 번호는 글자가 아니라 자동 번호)',
  '본문 문단 3개는 번호 없이 스타일 "본문"',
  '표 3행 2열, 쪽 너비에 맞게 두 열이 같은 너비, 표 앞뒤에 개요 번호가 붙지 않음',
  '표 첫 행 "기능 | 설명" 이 굵게, 표 속성 → 셀에서 "제목 셀", 표 속성 → 표에서 "제목 줄 자동 반복" 이 켜져 있는지',
  '"말로 고치기" 의 설명 칸이 두 줄(칸 안 문단 2개)',
  '"2. 주요 기능" 과 표 사이, 표와 "표 아래 본문 문단." 사이에 빈 줄이 없는지',
];

const files: CheckFile[] = [
  {
    file: '01-빈문서-제안서.hwpx',
    source: 'createBlankDocument()',
    start: () => ({ doc: createBlankDocument() }),
    titleStyle: 'title',
    look: COMMON_LOOK,
    exactNumbers: true,
  },
  {
    file: '02-빈문서-제목스타일없이.hwpx',
    source: 'createBlankDocument()',
    start: () => ({ doc: createBlankDocument() }),
    titleStyle: 'normal',
    look: ['01 과 같고 제목만 바탕글(스타일을 더하지 않음). 01 에서 경고가 나면 이것도 열어 "제목" 스타일 때문인지 가른다'],
    exactNumbers: true,
  },
  {
    file: '03-양식(공문)-제안서.hwpx',
    source: 'fixtures/notice.hwpx',
    start: () => {
      const doc = openDocumentFile(fixture('notice.hwpx'));
      return { doc, cleared: clearTemplateBody(doc) };
    },
    titleStyle: 'title',
    look: [...COMMON_LOOK, '원래 공문의 본문(표·누름틀 포함)이 하나도 남지 않았는지, 쪽 여백이 공문과 같은지'],
    exactNumbers: true,
  },
  {
    file: '04-양식(보고서+머리말꼬리말)-제안서.hwpx',
    source: 'fixtures/report.hwpx + rhwp 로 머리말·꼬리말을 더함',
    start: () => {
      const doc = withHeaderFooter(fixture('report.hwpx'));
      return { doc, cleared: clearTemplateBody(doc) };
    },
    titleStyle: 'title',
    look: [...COMMON_LOOK, '머리말 "가나다구청 · 머리말", 꼬리말 "꼬리말 · 대외비" 가 남아 있는지', '원래 보고서 본문(4×4 표 포함)이 남지 않았는지'],
    exactNumbers: true,
  },
];

for (const path of (process.env.DOCBRIDGE_CREATE_TEMPLATES ?? '').split(',').filter((p) => p.length > 0)) {
  files.push({
    file: `0${files.length + 1}-선택-한컴양식(${basename(path).replace(/\.hwpx?$/, '')})-제안서.hwpx`,
    source: '로컬 한컴 문서(레포에 넣지 않음)',
    start: () => {
      const doc = openDocumentFile(path);
      return { doc, cleared: clearTemplateBody(doc) };
    },
    titleStyle: 'title',
    exactNumbers: false,
    look: [
      ...COMMON_LOOK.filter((line) => !line.startsWith('개요 번호')),
      '개요 번호는 이 양식의 "개요 1"·"개요 2" 스타일을 따른다. 아래 "rhwp 가 매긴 번호" 와 한글에서 보이는 번호가 같은지',
      '한컴이 저장한 실제 문서를 양식으로 쓴 것. 머리말·꼬리말·쪽 번호가 원래 문서처럼 남았는지, 본문 그림·표·글상자가 남지 않았는지',
      '구역이 여럿인 문서는 구역마다 빈 쪽이 남는다(내용은 첫 구역에). 그 빈 쪽이 이상하게 보이는지',
    ],
  });
}

/** get_outline 결과(id·종류·번호·글자) 한 줄씩 */
function outlineLines(doc: HwpDocument): string[] {
  const blocks = extractBlocks(doc);
  const labeled = BlockIdTable.assign(blocks).label(blocks).flatMap(({ id, block }) => (id === undefined ? [] : [{ id, block }]));
  return outline(labeled).blocks.map((b) => `${b.id} ${b.kind}${b.number ? ` ${b.number}` : ''} ${b.text}`);
}

/** 비교용: 블록 종류 + 번호 + 전체 글자(id·자르기 없이). withNumbers 가 거짓이면 번호를 뺀다 */
function contentLines(doc: HwpDocument, withNumbers = true): string[] {
  return extractBlocks(doc).map((b) => {
    switch (b.kind) {
      case 'paragraph':
        return `paragraph ${withNumbers && b.number ? `${b.number} ` : ''}${b.text}`;
      case 'table':
        return `table ${b.cells.map((c) => c.text).join(' | ')}`;
      case 'field':
        return `field ${b.name}=${b.value}`;
    }
  });
}

mkdirSync(outDir, { recursive: true });
const baseline = exportVerifiedHwpx(createBlankDocument());
writeFileSync(join(outDir, '00-기준-빈문서(편집없음).hwpx'), baseline.bytes);

const readme: string[] = [
  'docbridge 새 문서 만들기 한글 확인용 파일 (SPEC-003 기술 검증 #35)',
  '',
  '각 파일을 한글 프로그램(맥 한컴 뷰어 또는 한글)에서 열어 아래를 확인해 주세요.',
  '- 열 때 "손상", "변조", "복구" 같은 경고가 뜨는지 (뜨면 문구를 그대로 알려주세요)',
  '- 각 파일 "확인할 것" 이 맞는지',
  '- 비교: python-hwpx 로 만든 ~/Downloads/DocBridge_도입제안서_v0.1.hwpx 와 보이는 모양이 어떻게 다른지(그쪽은 모두 바탕글 + 직접 서식, 번호는 글자)',
  '',
  '■ 00-기준-빈문서(편집없음).hwpx',
  '  rhwp 빈 문서 템플릿을 아무것도 하지 않고 HWPX 로 저장한 것. 다른 파일에서 경고가 나면 이것도 열어 보고 알려주세요',
  '  (rhwp 빈 문서·HWPX 저장 자체 문제인지, 스타일·표 만들기 때문인지 가르는 용도)',
  '',
];

for (const check of files) {
  const { doc, cleared } = check.start();
  fill(doc, check.titleStyle);
  const verified = exportVerifiedHwpx(doc);
  if (verified.reopenError !== undefined) throw new Error(`${check.file}: 다시 열지 못했습니다: ${verified.reopenError}`);
  if (verified.different.length > 0) throw new Error(`${check.file}: 다시 연 문서와 블록이 다릅니다: ${verified.different.join(', ')}`);
  const path = join(outDir, check.file);
  writeFileSync(path, verified.bytes);

  const reopened = openDocumentFile(path);
  const actual = contentLines(reopened, check.exactNumbers);
  const expected = check.exactNumbers ? EXPECTED : EXPECTED.map((line) => line.replace(/^paragraph (\d+\.|[가-하]\.) /, 'paragraph '));
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${check.file}: 다시 연 파일 내용이 다릅니다:\n${actual.join('\n')}`);
  }

  readme.push(`■ ${check.file}  (시작: ${check.source})`);
  if (cleared !== undefined) {
    readme.push(`  양식 본문 비우기: 지운 개체 ${JSON.stringify(cleared.removedObjects)}, 남긴 개체 ${JSON.stringify(cleared.keptObjects)}`);
  }
  readme.push('  확인할 것:');
  for (const line of check.look) readme.push(`   - ${line}`);
  if (!check.exactNumbers) {
    const numbers = extractBlocks(reopened).flatMap((b) => (b.kind === 'paragraph' && b.number !== undefined ? [`${b.number} ${b.text}`] : []));
    readme.push(`  rhwp 가 매긴 번호: ${numbers.length === 0 ? '없음(이 양식의 개요 스타일은 번호가 없는 모양)' : numbers.join(' / ')}`);
  }
  const compared = check.exactNumbers ? '번호·표 칸 포함' : '글자·표 칸, 번호는 양식대로';
  readme.push(`  rhwp 로 다시 열어 확인: 블록 ${actual.length}개가 기대와 같음(${compared}), 손실 보고 ${verified.losses.length}건`);
  readme.push('');

  console.log(`\n## ${check.file} (${check.source})`);
  if (cleared !== undefined) console.log(`비우기: 지움 ${JSON.stringify(cleared.removedObjects)}, 남김 ${JSON.stringify(cleared.keptObjects)}`);
  console.log(`get_outline (다시 연 파일):\n${outlineLines(reopened).join('\n')}`);
  console.log(`검증: 다른 블록 ${verified.different.length}, 손실 ${verified.losses.length}, ${verified.bytes.length} bytes`);
}

writeFileSync(join(outDir, 'README.txt'), `${readme.join('\n')}\n`);
console.log(`\n${outDir} 에 기준 1개 + ${files.length}개 + README.txt`);
