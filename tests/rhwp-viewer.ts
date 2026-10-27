// 테스트용 뷰어 요청 처리: 브라우저 뷰어처럼 rhwp 로 문서를 열고 블록을 뽑아 들고 있다가 요청에 답한다.
// 렌더링은 하지 않는다. Node 의 글자 폭 근사 때문에 쪽 나눔은 브라우저와 다를 수 있다(ADR 001).
// 편집·되돌리기는 뷰어와 같은 공용 경로(core/document-editor.ts)를, 저장 전 검증은 뷰어와 같은 exportForSave 를 쓴다.
import { HwpDocument } from '@rhwp/core';
import { blockPositionSchema } from '../src/core/block-schema.ts';
import { DocumentEditor } from '../src/core/document-editor.ts';
import { findInBlocks } from '../src/core/find-text.ts';
import { blockBoxes, highlightTargets } from '../src/core/highlight-targets.ts';
import { exportForSave, type Reopen } from '../src/core/hwpx-export.ts';
import type { BlockAnchor } from '../src/core/block-ids.ts';
import { initRhwpForNode } from '../src/core/rhwp-node.ts';
import type { RequestMessage, ViewerParams } from '../src/shared/protocol.ts';

export interface RhwpViewerOptions {
  /** 저장 전 검증에서 내보낸 바이트를 다시 여는 방법(검증 실패를 흉내낼 때) */
  reopen?: Reopen;
}

export interface RhwpViewer {
  handle: (request: RequestMessage) => unknown;
  /** 지금 열린 문서(테스트가 글자 모양 등을 직접 읽는다) */
  editor: () => DocumentEditor;
  /** 받은 edit_state 들(순서대로) */
  readonly editStates: Array<ViewerParams<'edit_state'>>;
  /** 뷰어가 아는 저장하지 않은 편집 수(확인 창 기준): 편집·되돌리기 요청에 실려 오거나 edit_state 로 온 값 */
  unsavedEdits(): number;
}

export function rhwpViewer(options: RhwpViewerOptions = {}): RhwpViewer {
  initRhwpForNode();
  let editor: DocumentEditor | undefined;
  const editStates: Array<ViewerParams<'edit_state'>> = [];
  let unsaved = 0;
  const opened = () => {
    if (editor === undefined) throw new Error('뷰어에 열린 문서가 없습니다');
    return editor;
  };
  const handle = (request: RequestMessage): unknown => {
    switch (request.method) {
      case 'load_document': {
        editor?.dispose();
        editor?.doc.free();
        editor = undefined;
        editor = new DocumentEditor(new HwpDocument(new Uint8Array(Buffer.from(request.params.data, 'base64'))));
        unsaved = 0;
        return { pageCount: editor.doc.pageCount(), blocks: editor.blocks.map((block) => blockPositionSchema.parse(block)) };
      }
      case 'get_blocks':
        return opened().blocks;
      case 'find_text':
        return findInBlocks(opened().blocks, request.params.query);
      case 'highlight': {
        // 그리지는 않고, 뷰어와 같은 함수로 대상을 사각형으로 바꿔 검사한 뒤 뷰어와 같은 결과를 준다
        const { pages, warnings } = highlightTargets(opened().doc, opened().blocks, request.params.targets);
        return { pages, ...(warnings.length === 0 ? {} : { warnings }) };
      }
      case 'clear_highlight':
        return {};
      case 'edit': {
        // 그리지는 않고, 뷰어와 같은 함수로 표시 자리를 구해 표시하지 못한 블록을 돌려준다
        let unmarked: BlockAnchor[] = [];
        const editor = opened();
        const changed = editor.edit(request.params.operation, request.params.depth, (changedBlocks, blocks) => {
          unmarked = blockBoxes(editor.doc, blocks, changedBlocks.map(({ anchor }) => anchor)).unmarked;
        });
        unsaved = request.params.unsavedEdits;
        return { changed, unmarked, pageCount: editor.doc.pageCount() };
      }
      case 'undo': {
        const undone = opened().undo(request.params.steps, request.params.depth);
        if (undone === request.params.steps) unsaved = request.params.unsavedEdits;
        return { undone, pageCount: opened().doc.pageCount() };
      }
      case 'export_hwpx':
        return exportForSave(opened().doc, options.reopen === undefined ? {} : { reopen: options.reopen });
      case 'edit_state':
        editStates.push(request.params);
        unsaved = request.params.unsavedEdits;
        return {};
    }
  };
  return { handle, editor: opened, editStates, unsavedEdits: () => unsaved };
}

/** 요청 처리 함수만 쓰는 테스트용 */
export const rhwpViewerHandler = () => rhwpViewer().handle;
