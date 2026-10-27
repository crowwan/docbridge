// save_document (SPEC-002 "저장"): 경로를 정하고, 뷰어(rhwp)가 내보내 검증한 HWPX 를 서버가 파일로 쓴다.
// 검증에 실패하면 파일을 쓰지 않고 달라진 블록 id 를 돌려준다(AC-10). 쓰다 실패하면 문서 상태를 그대로 둔다.
import type { ContentLoss } from '../core/hwpx-export.ts';
import { base64Length, MAX_DOCUMENT_BYTES, tooLargeMessage } from '../shared/limits.ts';
import type { ViewerResult } from '../shared/protocol.ts';
import { newDocumentTakenMessage, protectedSource, resolveNewDocumentSavePath, resolveSavePath, writeSave } from './save-path.ts';
import type { DocumentSession, OpenedDocument } from './session.ts';

export interface SaveArgs {
  path?: string;
  overwrite?: boolean;
}

export interface SaveResult {
  /** 저장한 파일의 절대 경로(이제 마지막 파일) */
  path: string;
  /** 파일 크기(바이트) */
  bytes: number;
  /** 저장 전 검증: 다시 연 파일과 블록 수·블록별 글자가 같았다 */
  verified: { blockCount: number };
  /** 내보내기 보고서의 손실 항목(파일은 썼다) */
  warnings?: string[];
}

const VERIFY_FAILED = '저장 전 검증에 실패해 파일을 쓰지 않았습니다.';

const lossWarning = ({ code, subject, path, reason }: ContentLoss) =>
  `HWPX 로 내보내며 빠지거나 줄어든 내용이 있습니다: ${subject}(${code}, ${reason}) — ${path}`;

/** 검증 실패 결과를 사용자에게 보일 이유로. 달라진 블록은 서버 id 표의 id 로 */
function verificationError(document: OpenedDocument, failed: Extract<ViewerResult<'export_hwpx'>, { verified: false }>): Error {
  if (failed.reopenError !== undefined) {
    return new Error(`${VERIFY_FAILED} 내보낸 HWPX 를 다시 열지 못했습니다: ${failed.reopenError}`);
  }
  const labeled = document.ids.label(failed.blocks);
  const ids = failed.different.map((index) => {
    const entry = labeled[index];
    if (entry === undefined) return `(${index + 1}번째 블록)`;
    return entry.id ?? `(id 없음: 구역 ${entry.block.section} 문단 ${entry.block.paragraph})`;
  });
  const extra = failed.extraBlocks === 0 ? '' : ` 다시 연 문서에 블록이 ${failed.extraBlocks}개 더 있습니다.`;
  const listed = ids.length === 0 ? '' : ` 다시 연 문서와 다른 블록: ${ids.join(', ')}.`;
  return new Error(`${VERIFY_FAILED}${listed}${extra}`);
}

/** 뷰어가 보낸 base64 를 바이트로. 상한을 넘으면 풀기 전에(글자 수로) 먼저 거르고, 푼 길이가 맞지 않으면 쓰지 않는다 */
export function decodeExport(data: string, byteLength: number, maxBytes = MAX_DOCUMENT_BYTES): Uint8Array {
  if (data.length > base64Length(maxBytes)) throw new Error(tooLargeMessage(Math.floor((data.length * 3) / 4), maxBytes));
  const bytes = Buffer.from(data, 'base64');
  // 글자 수 검사는 3바이트 단위라 상한을 1~2바이트 넘는 것은 푼 뒤에 걸린다
  if (bytes.length > maxBytes) throw new Error(tooLargeMessage(bytes.length, maxBytes));
  if (bytes.length !== byteLength) {
    throw new Error(`뷰어가 보낸 파일이 온전하지 않습니다(${byteLength}바이트 중 ${bytes.length}바이트). 다시 저장하세요.`);
  }
  return bytes;
}

/**
 * 저장은 열기·새로고침·편집·되돌리기와 같은 줄에 선다(session.exclusive): 내보낸 문서와 기록한 저장 상태가 같은 편집 시점이고,
 * 저장하는 사이 다른 문서가 열리지 않는다. write 는 파일 쓰기(테스트에서 쓰는 사이 일을 끼워 넣을 때 바꾼다)
 */
export function saveDocument(session: DocumentSession, args: SaveArgs, write = writeSave): Promise<SaveResult> {
  return session.exclusive(async (document, send) => {
    // overwrite 는 path 를 줬을 때만 뜻이 있다. path 가 없으면 늘 기본 이름을 새로 만든다(겹치면 번호)
    const overwrite = args.path !== undefined && (args.overwrite ?? false);
    // 경로가 틀렸으면 내보내기(큰 문서는 0.5초)를 하지 않는다
    // 한 번도 저장하지 않은 새 문서는 원본이 없다: 경로가 없으면 create_document 의 자리, 상대 경로는 그 폴더 기준(SPEC-003)
    const { location } = document;
    const resolved =
      location.kind === 'file'
        ? await resolveSavePath({ sourcePath: location.sourcePath, path: args.path, overwrite })
        : await resolveNewDocumentSavePath({ savePath: location.savePath, path: args.path, overwrite });
    const exported = await send('export_hwpx', {});
    if (!exported.verified) throw verificationError(document, exported);
    const bytes = decodeExport(exported.data, exported.byteLength);
    // 기본 이름(<이름>-수정)은 그사이 같은 이름이 생기면(동시 저장, 다른 프로그램) 다음 번호로 쓴다. 새 문서의 자리는 번호를 붙이지 않고 덮지 않는다
    const protectedPath = location.kind === 'file' ? protectedSource(location.sourcePath) : undefined;
    const path = await write(
      {
        path: resolved,
        overwrite,
        numbered: args.path === undefined && location.kind === 'file',
        ...(protectedPath === undefined ? {} : { protectedPath }),
        // 경로 없는 새 문서 저장은 overwrite 가 쓰이지 않는다 — 경로 + overwrite 나 다른 경로를 안내
        ...(location.kind === 'new' && args.path === undefined ? { existing: newDocumentTakenMessage } : {}),
      },
      bytes,
    );
    await session.recordSave(document, path, exported.blocks);
    const warnings = exported.losses.map(lossWarning);
    return {
      path,
      bytes: bytes.length,
      verified: { blockCount: exported.blocks.length },
      ...(warnings.length === 0 ? {} : { warnings }),
    };
  });
}
