// 뷰어가 window 에 여는 검증용 API. Playwright 측정·하이라이트 테스트가 쓴다.
import type { SelectionRect, TextRange } from '../core/highlight-rects.ts';
import type { UserEdit } from '../shared/protocol.ts';

export type { SelectionRect, TextRange };

export interface RenderMetrics {
  /** WASM 내려받기·컴파일·초기화 시간(ms) */
  wasmInitMs: number;
  /** 문서 파싱(openHwpDocument: new HwpDocument + 줄 배치가 빠진 문단 다시 배치) 시간(ms). 문서를 안 열었으면 0 */
  parseMs: number;
  /** 쪽마다 renderPageToCanvas 시간(ms) */
  pageRenderMs: number[];
  pageCount: number;
}

export interface ViewerApi {
  ready: Promise<RenderMetrics>;
  /** 범위의 줄별 사각형을 구해 오버레이를 그리고 첫 사각형으로 스크롤한다. 이전 하이라이트는 지운다 */
  highlight(range: TextRange): SelectionRect[];
  /** 사람 편집을 서버에 보낸다(SPEC-006). 서버가 거부하면 그 문구로 실패한다. 더블클릭·끌기 UI(#59·#60)와 E2E 가 쓴다 */
  userEdit(edit: UserEdit): Promise<void>;
}

declare global {
  interface Window {
    docbridge?: ViewerApi;
  }
}
