// 도구 막대 PDF 버튼(SPEC-008 AC-7, #109): 누르면 서버에 사람 요청(user_export_pdf)을 보내 export_pdf 기본 경로(문서 옆 <이름>.pdf)에 저장하고,
// 뷰어 아래 알림(toast.ts)으로 저장한 경로를 알린다. 실패는 서버가 고른 사람용 문구(#77 rejections).
// 만드는 동안은 aria-busy·aria-disabled 로 꺼 두고 누름을 무시한다 — disabled 속성을 쓰지 않는 것은 누른 버튼의 포커스를 잃지 않게(키보드로 누른 사람이 제자리에 있게).
// 버튼은 서버가 연 문서가 있을 때만 보인다(빈 탭·닫은 문서·개발 화면에는 없다).
import { errorMessage } from '../shared/errors.ts';
import type { ToastKind } from './toast.ts';

export interface PdfButton {
  /** 서버가 연 문서가 있을 때만 보인다 */
  setAvailable(available: boolean): void;
}

export interface PdfButtonOptions {
  /** 서버에 PDF 저장을 부탁하고 저장한 경로를 받는다 */
  exportPdf: () => Promise<string>;
  report: (message: string, kind: ToastKind) => void;
}

export const savedPdfMessage = (path: string) => `PDF 로 저장했습니다: ${path}`;

export function setupPdfButton(button: HTMLButtonElement, options: PdfButtonOptions): PdfButton {
  let busy = false;
  const setBusy = (value: boolean): void => {
    busy = value;
    button.setAttribute('aria-busy', String(value));
    button.setAttribute('aria-disabled', String(value));
  };
  setBusy(false);
  button.addEventListener('click', () => {
    if (busy) return;
    setBusy(true);
    options
      .exportPdf()
      .then(
        (path) => options.report(savedPdfMessage(path), 'success'),
        (error: unknown) => options.report(errorMessage(error), 'error'),
      )
      .finally(() => setBusy(false));
  });
  return {
    setAvailable(available) {
      button.hidden = !available;
    },
  };
}
