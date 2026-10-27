// SPEC-007 기술 검증(#62): 한글 프로그램에서 열어 볼 "다른 문서에서 문단·표를 복사해 넣은" HWPX 파일을 만든다(ADR 004, AC-9 수동 QA 재료).
// 원본은 tests/copy-source.ts(공문 fixture + 그림 문단·사용자 스타일 문단·개요 스타일 문단). 원본 탭이 보낼 HWPX 바이트에서 시작해
// src/core/copy-paragraphs.ts copyParagraphs 로 대상 fixture 에 넣고, 내보내기 전 검증(다시 열어 블록 비교)을 거친다.
// 보정 없이 rhwp 만 쓴 파일과 HTML 붙이기 대안 파일도 같이 만든다(한글에서 차이를 보려고).
// 실행: node scripts/make-copy-check.ts [출력 폴더]   (기본 ~/Downloads/docbridge-copy-check)
// 결과물은 레포에 넣지 않는다.
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HwpDocument } from '@rhwp/core';
import { BlockIdTable } from '../src/core/block-ids.ts';
import { extractBlocks } from '../src/core/blocks.ts';
import { copyParagraphs, DEFAULT_SOURCES, type CopyCorrections } from '../src/core/copy-paragraphs.ts';
import { exportVerifiedHwpx } from '../src/core/hwpx-export.ts';
import { openDocumentFile } from '../src/core/rhwp-node.ts';
import { outline } from '../src/server/reading.ts';
import { buildCopySource, SRC } from '../tests/copy-source.ts';

const S = 0;
const outDir = process.argv[2] ?? join(homedir(), 'Downloads', 'docbridge-copy-check');
const fixture = (name: string) => openDocumentFile(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)));

const source = buildCopySource();
const sourceBytes = source.exportHwpx();
/** 번호 문단 ~ 개요 스타일 문단(표·그림·서명·사용자 스타일 포함) */
const ALL = { section: S, start: SRC.numbered.start, end: SRC.outlineStyle + 1 };

interface CheckFile {
  file: string;
  /** 대상 문서를 만들고 복사한다. 보정 결과가 있으면 돌려준다 */
  make: () => { doc: HwpDocument; corrections?: CopyCorrections };
  look: string[];
}

function copyInto(target: string, from: { start: number; end: number }, before: number) {
  const doc = fixture(target);
  const result = copyParagraphs(doc, sourceBytes, { section: S, ...from }, { section: S, before });
  if (!result.ok) throw new Error(`${target}: 복사가 거부됐습니다: ${JSON.stringify(result.rejected)}`);
  return { doc, corrections: result.corrections };
}

const COPIED_LOOK = [
  '복사해 넣은 "1. 관련" ~ "3. 회신 기한" 이 자동 번호(글자가 아니라)이고 "가. 나. 다." 하위 번호가 원본처럼 들여 있다',
  '3×3 표(구분·일정·장소)가 원본 공문처럼 나온다',
  '"가나다구청장" 이 가운데 정렬·18pt 굵게',
  '"그림 문단" 끝에 작은 그림(1×1 PNG 를 3000×3000 HWPUNIT 로 늘린 회색/검은 네모)이 있다',
  '"강조 스타일 문단" 이 오른쪽 정렬·14pt 굵게 파랑, 스타일 목록에 "강조 문단" 이 한 번 있다',
  '서식 → 스타일 목록에 "바탕글"·"개요 1" 이 두 번 나오지 않는다',
];

const files: CheckFile[] = [
  {
    file: '01-보고서에-공문문단표그림스타일.hwpx',
    make: () => copyInto('report.hwpx', ALL, 2),
    look: [
      '보고서 제목 바로 뒤에 공문 문단들이 들어가 있다',
      ...COPIED_LOOK,
      '"개요 스타일 문단" 이 보고서 개요 번호를 따라 "1." 이고, 원래 보고서 "개요" 가 "2." 로, 뒤 개요도 하나씩 밀린다',
    ],
  },
  {
    file: '02-공문에-번호문단-이어매기기.hwpx',
    make: () => copyInto('notice.hwpx', { start: 10, end: 11 }, 6),
    look: ['"3. 회신 기한" 을 공문 "2. 하반기…" 앞에 넣었다: 번호가 1. 관련 / 2. 회신 기한 / 3. 하반기… / 4. 회신 기한 으로 이어진다(새 목록 1. 이 아니라)'],
  },
  {
    file: '03-개요문서에-개요스타일문단.hwpx',
    make: () => copyInto('outline-demo.hwpx', { start: SRC.outlineStyle, end: SRC.outlineStyle + 1 }, 4),
    look: ['"개요 스타일 문단" 이 "1. 총칙" 다음 개요 "2." 가 되고, 뒤 "가. 목적" 은 "가." 로 새로 시작한다(2. 아래 첫 하위 개요)'],
  },
  {
    file: '04-신청서에-공문문단표그림스타일.hwpx',
    make: () => copyInto('application.hwpx', ALL, 2),
    look: ['신청서 제목 뒤에 공문 문단들이 들어가 있다', ...COPIED_LOOK, '"개요 스타일 문단" 은 신청서에 개요가 없어 "1."'],
  },
  {
    file: '05-보정없이-rhwp그대로-보고서.hwpx',
    make: () => {
      // copyParagraphs 의 보정(번호 정의·스타일 다시 가리키기, 복제 스타일 지우기) 없이 importParagraphBlock 만
      const doc = fixture('report.hwpx');
      const open = DEFAULT_SOURCES[0];
      if (open === undefined) throw new Error('원본 핸들 만들기가 없습니다');
      const handle = open(sourceBytes);
      doc.importParagraphBlock(
        handle,
        JSON.stringify({ request: { sourceSection: S, sourceStart: ALL.start, sourceEnd: ALL.end, targetSection: S, insertBefore: 2, count: 1 }, dryRun: false }),
      );
      handle.free();
      return { doc };
    },
    look: [
      '01 과 같은 복사를 docbridge 보정 없이 한 것. 비교용',
      '스타일 목록에 "바탕글"·"개요 1" 이 두 번씩 있다(rhwp 가 복제해 더함). 한글이 이것을 문제 삼는지(경고·스타일 목록 모양)',
      '"개요 스타일 문단" 이 보고서 개요와 따로 "1." 이고 보고서 "개요" 도 "1." 그대로',
    ],
  },
  {
    file: '06-대안-HTML붙이기-보고서.hwpx',
    make: () => {
      const doc = fixture('report.hwpx');
      const end = SRC.outlineStyle;
      doc.pasteHtml(S, 1, 0, source.exportSelectionHtml(S, ALL.start, 0, end, source.getParagraphLength(S, end)));
      return { doc };
    },
    look: [
      '대안(exportSelectionHtml → pasteHtml)으로 같은 범위를 붙인 것. 비교용',
      '번호가 없고(자동 번호도 글자도), 표·그림이 빠지고, 모든 문단이 바탕글이다. 글자 크기·굵게·정렬만 남는다',
    ],
  },
];

/** get_outline 결과(id·종류·번호·글자) 한 줄씩 */
function outlineLines(doc: HwpDocument): string[] {
  const blocks = extractBlocks(doc);
  const labeled = BlockIdTable.assign(blocks).label(blocks).flatMap(({ id, block }) => (id === undefined ? [] : [{ id, block }]));
  return outline(labeled).blocks.map((b) => `${b.id} ${b.kind}${b.number ? ` ${b.number}` : ''} ${b.text}`);
}

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, '00-원본-공문(복사해-온-문서).hwpx'), exportVerifiedHwpx(source).bytes);

const readme: string[] = [
  'docbridge 문서 사이 복사 한글 확인용 파일 (SPEC-007 기술 검증 #62, ADR 004)',
  '',
  '각 파일을 한글 프로그램(맥 한컴 뷰어 또는 한글)에서 열어 아래를 확인해 주세요.',
  '- 열 때 "손상", "변조", "복구" 같은 경고가 뜨는지 (뜨면 문구를 그대로 알려주세요)',
  '- 각 파일 "확인할 것" 이 맞는지, 00-원본 과 나란히 놓고 서식이 같은지',
  '',
  '■ 00-원본-공문(복사해-온-문서).hwpx',
  '  복사해 온 원본(공문 fixture 끝에 그림 문단·"강조 문단" 스타일 문단·"개요 1" 스타일 문단을 더한 것). 다른 파일과 비교용',
  '',
];

for (const check of files) {
  const { doc, corrections } = check.make();
  const verified = exportVerifiedHwpx(doc);
  if (verified.reopenError !== undefined) throw new Error(`${check.file}: 다시 열지 못했습니다: ${verified.reopenError}`);
  if (verified.different.length > 0) throw new Error(`${check.file}: 다시 연 문서와 블록이 다릅니다: ${verified.different.join(', ')}`);
  const path = join(outDir, check.file);
  writeFileSync(path, verified.bytes);

  readme.push(`■ ${check.file}`);
  if (corrections !== undefined) readme.push(`  docbridge 보정: ${JSON.stringify(corrections)}`);
  readme.push('  확인할 것:');
  for (const line of check.look) readme.push(`   - ${line}`);
  readme.push(`  rhwp 로 다시 열어 확인: 블록이 저장 전과 같음, 손실 보고 ${verified.losses.length}건`);
  readme.push('');

  console.log(`\n## ${check.file}`);
  if (corrections !== undefined) console.log(`보정: ${JSON.stringify(corrections)}`);
  console.log(`get_outline (다시 연 파일, 앞 20블록):\n${outlineLines(openDocumentFile(path)).slice(0, 20).join('\n')}`);
  console.log(`검증: 다른 블록 ${verified.different.length}, 손실 ${verified.losses.length}, ${verified.bytes.length} bytes`);
}

writeFileSync(join(outDir, 'README.txt'), `${readme.join('\n')}\n`);
console.log(`\n${outDir} 에 원본 1개 + ${files.length}개 + README.txt`);
