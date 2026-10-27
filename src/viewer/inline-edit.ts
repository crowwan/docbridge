// 더블클릭으로 글자 고치기(SPEC-006): 마우스 올림 테두리와 블록 위 입력칸. 자리 찾기·바뀐 범위는 core/edit-spot.ts,
// 서버에 보내기는 main.ts(host.commit). 입력칸은 Enter·바깥 클릭이면 적용, Esc 면 취소, 줄바꿈은 받지 않는다.
// 입력칸이 열린 동안 Claude 편집이 오면 닫지 않고(다시 그린 쪽에 다시 붙인다) 블록 위치를 따라간다(follow).
import { followEdit, type EditSpot, type Point } from '../core/edit-spot.ts';
import type { SelectionRect } from '../core/highlight-rects.ts';
import type { ParagraphChanges } from '../core/paragraph-changes.ts';

export interface InlineEditHost {
  /** 쪽(0부터) 위 점(쪽 px, 배율 1)의 고칠 자리와 테두리 사각형. 문서가 없거나 고칠 수 없는 자리면 undefined */
  spotAt(pageIndex: number, point: Point): { spot: EditSpot; box: SelectionRect } | undefined;
  /** 지금 그려진 쪽 요소들 */
  pageEls(): HTMLElement[];
  zoom: number;
  /**
   * 적용: 입력칸을 열 때의 자리(Claude 편집을 따라 옮긴 위치, 그 블록 문단이 지워지거나 되돌려졌으면 undefined)와 입력칸 글자.
   * 고친 것이 없으면 부르지 않는다
   */
  commit(spot: EditSpot | undefined, text: string): void;
}

export interface InlineEdit {
  /** 쪽을 다시 그린 뒤: 열린 입력칸을 새 쪽 요소에 다시 붙이고 마우스 올림 테두리는 지운다 */
  reattach(): void;
  /** 입력칸이 열린 동안 적용된 편집을 따라간다(changes 가 없으면 위치 그대로) */
  followEdit(changes: ParagraphChanges | undefined): void;
  /** 입력칸이 열린 동안 되돌리기가 적용됐다 — 위치를 따라갈 수 없어 적용할 때 거부한다 */
  loseSpot(): void;
  /** 적용하지 않고 닫는다(문서를 바꿈) */
  cancel(): void;
}

interface Editing {
  spot: EditSpot | undefined;
  original: string;
  pageIndex: number;
  textarea: HTMLTextAreaElement;
}

/** 글자 위치(유니코드 글자) → 입력칸 위치(UTF-16) */
const utf16Index = (text: string, chars: number) => [...text].slice(0, chars).join('').length;

export function setupInlineEdit(pagesEl: HTMLElement, host: InlineEditHost): InlineEdit {
  let editing: Editing | undefined;
  const hover = document.createElement('div');
  hover.className = 'edit-hover';
  hover.dataset['testid'] = 'edit-hover';

  const place = (el: HTMLElement, box: SelectionRect) => {
    el.style.left = `${box.x * host.zoom}px`;
    el.style.top = `${box.y * host.zoom}px`;
    el.style.width = `${box.width * host.zoom}px`;
    el.style.height = `${box.height * host.zoom}px`;
  };

  /** 이벤트 자리 → 쪽 번호와 쪽 위 점 */
  const pointOf = (event: MouseEvent): { pageIndex: number; point: Point } | undefined => {
    const pageEls = host.pageEls();
    const pageIndex = pageEls.findIndex((pageEl) => pageEl.contains(event.target instanceof Node ? event.target : null));
    const pageEl = pageEls[pageIndex];
    if (pageEl === undefined) return undefined;
    const rect = pageEl.getBoundingClientRect();
    return { pageIndex, point: { x: (event.clientX - rect.left) / host.zoom, y: (event.clientY - rect.top) / host.zoom } };
  };

  const fitHeight = (textarea: HTMLTextAreaElement) => {
    textarea.style.height = 'auto';
    textarea.style.height = `${textarea.scrollHeight}px`;
  };

  const close = (): Editing | undefined => {
    const closing = editing;
    editing = undefined;
    closing?.textarea.remove();
    return closing;
  };

  const apply = () => {
    const closing = close();
    if (closing === undefined || closing.textarea.value === closing.original) return;
    host.commit(closing.spot, closing.textarea.value);
  };

  const open = (pageIndex: number, spot: EditSpot, box: SelectionRect) => {
    hover.remove();
    const textarea = document.createElement('textarea');
    textarea.className = 'inline-edit';
    textarea.setAttribute('aria-label', '블록 글자 고치기');
    textarea.rows = 1;
    textarea.value = spot.text;
    host.pageEls()[pageIndex]?.append(textarea);
    textarea.style.left = `${box.x * host.zoom}px`;
    textarea.style.top = `${box.y * host.zoom}px`;
    textarea.style.width = `${box.width * host.zoom}px`;
    textarea.style.minHeight = `${box.height * host.zoom}px`;
    fitHeight(textarea);
    const caret = utf16Index(spot.text, spot.caret);
    textarea.focus();
    textarea.setSelectionRange(caret, caret);
    editing = { spot, original: spot.text, pageIndex, textarea };

    textarea.addEventListener('keydown', (event) => {
      // 한글 조합 중 Enter 는 조합을 끝내는 것이라 적용하지 않는다
      if (event.isComposing) return;
      if (event.key === 'Enter') {
        // 줄바꿈은 받지 않는다(Shift+Enter 도 무시) — 문단 나누기는 범위 밖
        event.preventDefault();
        if (!event.shiftKey) apply();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        close();
      }
    });
    textarea.addEventListener('paste', (event) => {
      // 붙여 넣는 글자의 줄바꿈은 빈칸으로
      const pasted = event.clipboardData?.getData('text/plain');
      if (pasted === undefined || !/[\r\n]/.test(pasted)) return;
      event.preventDefault();
      textarea.setRangeText(pasted.replace(/\r?\n|\r/g, ' '), textarea.selectionStart, textarea.selectionEnd, 'end');
      fitHeight(textarea);
    });
    textarea.addEventListener('input', () => fitHeight(textarea));
  };

  pagesEl.addEventListener('dblclick', (event) => {
    if (editing !== undefined) return;
    const at = pointOf(event);
    const found = at === undefined ? undefined : host.spotAt(at.pageIndex, at.point);
    if (at === undefined || found === undefined) return;
    event.preventDefault();
    window.getSelection()?.removeAllRanges();
    open(at.pageIndex, found.spot, found.box);
  });

  // 바깥 클릭이면 적용(입력칸 안 클릭은 커서 옮기기). 창 전환 등 포커스만 잃은 것은 적용하지 않는다
  document.addEventListener(
    'pointerdown',
    (event) => {
      if (editing !== undefined && event.target !== editing.textarea) apply();
    },
    true,
  );

  // 마우스 올림 테두리: 고칠 수 있는 블록(표는 칸)을 옅게 두른다. 입력칸이 열려 있으면 그리지 않는다
  let pending: MouseEvent | undefined;
  pagesEl.addEventListener('mousemove', (event) => {
    if (pending === undefined) {
      requestAnimationFrame(() => {
        const last = pending;
        pending = undefined;
        if (last === undefined) return;
        const at = editing === undefined ? pointOf(last) : undefined;
        const found = at === undefined ? undefined : host.spotAt(at.pageIndex, at.point);
        if (at === undefined || found === undefined) {
          hover.remove();
          return;
        }
        place(hover, found.box);
        host.pageEls()[at.pageIndex]?.append(hover);
      });
    }
    pending = event;
  });
  pagesEl.addEventListener('mouseleave', () => {
    pending = undefined;
    hover.remove();
  });

  return {
    reattach() {
      hover.remove();
      if (editing === undefined) return;
      const { textarea, pageIndex } = editing;
      const { selectionStart, selectionEnd } = textarea;
      host.pageEls()[pageIndex]?.append(textarea);
      textarea.focus();
      textarea.setSelectionRange(selectionStart, selectionEnd);
    },
    followEdit(changes) {
      if (editing?.spot !== undefined) editing.spot = followEdit(editing.spot, changes);
    },
    loseSpot() {
      if (editing !== undefined) editing.spot = undefined;
    },
    cancel() {
      close();
      hover.remove();
    },
  };
}
