// export_pdf (SPEC-008, ADR 005): 뷰어가 쪽 SVG·글자 배치·화면 글꼴 이름을 주고, 서버가 pdf-lib 로 PDF 를 만들어 쓴다.
// 내보내기는 편집이 아니다 — 되돌리기 칸·저장하지 않은 편집 수를 건드리지 않고, 지금 화면 그대로(저장 전 편집 포함) 내보낸다.
// 경로 규칙은 save_document 와 같다(save-path.ts resolvePdfPath — 확장자만 .pdf, 한글 문서 경로는 거부).
import { dirname } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { PdfBuilder } from '../core/pdf-export.ts';
import type { FontLibrary } from '../core/pdf-fonts.ts';
import { extraFontDirs, systemFontLibrary } from '../core/pdf-fonts-node.ts';
import { z } from 'zod';
import { errorMessage } from '../shared/errors.ts';
import type { UserResult } from '../shared/protocol.ts';
import { EditRejection } from '../shared/rejections.ts';
import { log } from './log.ts';
import { nextPdfName, pdfBase, resolvePdfPath, writeSave } from './save-path.ts';
import type { DocumentSession, OpenedDocument } from './session.ts';

export interface ExportPdfArgs {
  path?: string;
  /** 쪽 범위(1부터, 예: "1-3,5"). 없으면 모든 쪽 */
  pages?: string;
  overwrite?: boolean;
}

export interface ExportPdfResult {
  path: string;
  pageCount: number;
  bytes: number;
  warnings?: string[];
}

export interface ExportPdfDeps {
  /** PDF 에 그릴 글꼴(서버: 시스템 글꼴, 처음 한 번 훑는다. 테스트: 시험 글꼴) */
  fonts: () => Promise<FontLibrary>;
  /** 진행 알림(그린 쪽 수 / 쪽 수 + 1, 마지막에 PDF 쓰기) — MCP progress 로 보낸다. done 은 알림마다 는다 */
  progress?: (done: number, total: number, message: string) => void;
  write?: typeof writeSave;
}

/**
 * 뷰어에 한 번에 묻는 쪽 수. 쪽 SVG 는 수십~350KB(실제 공고문, ADR 005)라 20쪽이면 메시지 하나가 많아야 7MB 쯤이고(ws 상한 100MB),
 * 뷰어 SVG 만들기는 쪽당 약 6ms 라 묶음마다 기존 요청 제한 시간(30초)에 한참 못 미친다
 */
export const PAGE_BATCH = 20;

export const unsavedEditsWarning = (count: number) => `저장하지 않은 편집 ${count}개가 PDF 에 들어갔습니다(HWPX 는 아직 저장 전)`;

let scannedFonts: Promise<FontLibrary> | undefined;

/**
 * 이 컴퓨터의 시스템 글꼴 목록(+ DOCBRIDGE_FONT_DIRS 폴더) — 처음 내보낼 때 한 번 훑고(비동기, 맥 1,200여 개) 서버 수명 동안 쓴다.
 * 글꼴 바이트는 목록이 들고 있는 캐시(96MB 상한, pdf-fonts-node.ts FONT_CACHE_BYTES)에 둔다. 훑기에 실패하면 다음에 다시 훑는다
 */
export function systemFonts(): Promise<FontLibrary> {
  scannedFonts ??= systemFontLibrary(undefined, extraFontDirs(process.env['DOCBRIDGE_FONT_DIRS'])).catch((error: unknown) => {
    scannedFonts = undefined;
    throw error;
  });
  return scannedFonts;
}

const PAGES_EXAMPLE = '(예: "1-3,5")';

/** "1-3,5" → 0부터 센 쪽(겹치면 한 번, 오름차순). 모양이 틀리거나 문서 쪽 수를 넘으면 사용자에게 보일 이유로 던진다 */
export function parsePages(spec: string, pageCount: number): number[] {
  const pages = new Set<number>();
  for (const part of spec.split(',')) {
    const match = /^\s*(\d+)\s*(?:-\s*(\d+)\s*)?$/.exec(part);
    if (match === null) throw new Error(`쪽 범위를 읽을 수 없습니다: "${spec}" ${PAGES_EXAMPLE}`);
    const from = Number(match[1]);
    const to = match[2] === undefined ? from : Number(match[2]);
    const label = part.trim();
    if (from < 1) throw new Error(`쪽 번호는 1부터입니다: ${label}`);
    if (from > to) throw new Error(`쪽 범위의 앞이 뒤보다 큽니다: ${label}`);
    if (to > pageCount) throw new Error(`쪽 범위가 문서 쪽 수(${pageCount}쪽)를 넘습니다: ${label}`);
    for (let page = from; page <= to; page += 1) pages.add(page - 1);
  }
  return [...pages].sort((a, b) => a - b);
}

/** 기본 이름의 기준(마지막 파일, 저장 전 새 문서는 처음 저장할 자리)과 상대 경로 기준 폴더(원본 폴더 — save_document 와 같다) */
function pdfPlace(document: OpenedDocument): { documentPath: string; baseDir: string } {
  const { location } = document;
  return location.kind === 'file'
    ? { documentPath: location.path, baseDir: dirname(location.sourcePath) }
    : { documentPath: location.savePath, baseDir: dirname(location.savePath) };
}

/** 다음 이벤트 루프 차례로 넘긴다(PDF 를 만드는 동안 MCP·뷰어 연결이 멈추지 않게) */
const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

interface DrawnPages {
  builder: PdfBuilder;
  pageCount: number;
  unsavedEdits: number;
  path: string;
  place: { documentPath: string };
  overwrite: boolean;
}

/**
 * 문서 줄(session.exclusive)에 서서 경로를 정하고, 쪽을 묶음씩 받아 바로 그리고 버린다(#114 — 모든 쪽 SVG 를 한꺼번에 들지 않게).
 * 받은 쪽은 모두 같은 편집 시점이다. 그리는 동안 이 문서의 다른 도구는 기다린다(300쪽 공고문 수 초). 다른 문서와 MCP 연결은 돈다(묶음 안에서도 쉰다)
 */
function drawPages(session: DocumentSession, args: ExportPdfArgs, deps: ExportPdfDeps, fonts: FontLibrary): Promise<DrawnPages> {
  return session.exclusive(async (document, send) => {
    const pages = args.pages === undefined ? Array.from({ length: document.pageCount }, (_, page) => page) : parsePages(args.pages, document.pageCount);
    // overwrite 는 path 를 줬을 때만 뜻이 있다(save_document 와 같다)
    const overwrite = args.path !== undefined && (args.overwrite ?? false);
    const place = pdfPlace(document);
    // 경로가 틀렸으면 쪽을 받지 않는다
    const path = await resolvePdfPath({ ...place, ...(args.path === undefined ? {} : { path: args.path }), overwrite });
    const builder = new PdfBuilder(await PDFDocument.create(), fonts, { pause: nextTurn });
    // progress 는 알림마다 늘어야 한다(MCP 규격 MUST) — 쪽마다 하나 + PDF 쓰기 한 단계
    const total = pages.length + 1;
    let drawn = 0;
    for (let start = 0; start < pages.length; start += PAGE_BATCH) {
      const batch = pages.slice(start, start + PAGE_BATCH);
      const result = await send('export_pdf_pages', { pages: batch });
      await builder.addPages(result.pages, result.screenFonts);
      drawn += batch.length;
      deps.progress?.(drawn, total, `쪽 ${drawn}/${pages.length} 그림`);
    }
    return { builder, pageCount: pages.length, unsavedEdits: document.edits.unsavedEdits, path, place, overwrite };
  });
}

export async function exportPdf(session: DocumentSession, args: ExportPdfArgs, deps: ExportPdfDeps): Promise<ExportPdfResult> {
  const started = performance.now();
  // 시스템 글꼴 목록(처음 한 번 훑기)은 문서 줄 밖에서 — 훑는 동안 이 문서의 다른 도구를 막지 않는다
  const fonts = await deps.fonts();
  const drawn = await drawPages(session, args, deps, fonts);
  deps.progress?.(drawn.pageCount + 1, drawn.pageCount + 1, 'PDF 쓰는 중');
  const pdf = await drawn.builder.finish();
  const write = deps.write ?? writeSave;
  const path = await write(
    {
      path: drawn.path,
      overwrite: drawn.overwrite,
      // 기본 이름은 그사이 같은 이름이 생기면(동시 내보내기, 다른 프로그램) 다음 번호로
      numbered: args.path === undefined,
      next: nextPdfName(pdfBase(drawn.place.documentPath)),
    },
    pdf.bytes,
  );
  log(`PDF 내보내기 ${drawn.pageCount}쪽 ${Math.round(performance.now() - started)}ms → ${path}`);
  const warnings = [...(drawn.unsavedEdits > 0 ? [unsavedEditsWarning(drawn.unsavedEdits)] : []), ...pdf.warnings];
  return { path, pageCount: drawn.pageCount, bytes: pdf.bytes.length, ...(warnings.length === 0 ? {} : { warnings }) };
}

/** 파일 읽기·쓰기 오류(fs 가 code·syscall 을 붙인다 — 권한 없음·디스크 가득·읽기 전용 등) */
const fileSystemErrorSchema = z.object({ code: z.string(), syscall: z.string() });

/**
 * 뷰어 도구 막대 PDF 버튼(SPEC-008 AC-7, user_export_pdf): export_pdf 기본 경로(문서 옆 <이름>.pdf, 겹치면 번호)로 저장한다.
 * 실패는 거부 코드로 바꿔 사람용 문구를 보이게 한다(#77 — 원래 문구는 bridge 가 로그에 남긴다)
 */
export async function exportPdfFromViewer(session: DocumentSession, fonts: ExportPdfDeps['fonts']): Promise<UserResult<'user_export_pdf'>> {
  try {
    const { path } = await exportPdf(session, {}, { fonts });
    return { path };
  } catch (error) {
    if (error instanceof EditRejection) throw error;
    // 쓰기 실패는 writeSave 가 "저장하지 못했습니다" 로 감싸 원래 오류를 cause 에 둔다
    const written = fileSystemErrorSchema.safeParse(error instanceof Error ? error.cause : undefined).success;
    const code = written ? 'export_write_failed' : 'export_failed';
    throw new EditRejection(code, `PDF 버튼 내보내기 실패: ${errorMessage(error)}`);
  }
}
