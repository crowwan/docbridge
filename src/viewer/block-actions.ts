// 끌어 옮기기와 오른쪽 클릭 메뉴(SPEC-006 옮기기·지우기, #60). 놓일 자리·메뉴 편집은 core/block-moves.ts,
// 서버에 보내기는 main.ts(host.send → user_edit), 거부 문구는 뷰어 아래 알림(toast.ts).
// - 끌기: 블록 위에서 누른 채 --drag-threshold 넘게 움직이면 시작. 놓일 자리에 가로선, 놓으면 move_blocks. Esc 면 취소
// - 메뉴: 블록 위 오른쪽 클릭, 또는 메뉴 키·Shift+F10(마우스가 올라가 있는 블록). 위로·아래로·지우기. 화살표·Home·End·Enter·Esc
import type { BlockAnchor } from '../core/block-ids.ts';
import { dropAt, type BlockBand, type DropSpot, type MenuEdits } from '../core/block-moves.ts';
import type { BodyBlockSpot, Point } from '../core/edit-spot.ts';
import type { UserEdit } from '../shared/protocol.ts';

export interface BlockActionsHost {
  /** 쪽(0부터) 위 점(쪽 px, 배율 1)의 본문 블록. 문서가 없거나(서버가 연 문서만) 블록 밖이면 undefined */
  blockAt(pageIndex: number, point: Point): BodyBlockSpot | undefined;
  /** 끌기를 시작할 때: 본문 블록마다 쪽별 사각형 */
  bands(): BlockBand[];
  /** 메뉴를 열 때: 그 블록의 지우기·위로·아래로 편집 */
  menuEdits(anchor: BlockAnchor): MenuEdits;
  pageEls(): HTMLElement[];
  zoom: number;
  /** 사람 편집을 서버에 보낸다(거부되면 host 가 알림) */
  send(edit: UserEdit): void;
}

export interface BlockActions {
  /** 끌기·메뉴를 그만둔다(쪽을 다시 그림·문서를 바꿈) */
  cancel(): void;
}

/** CSS 길이 토큰(px) — 뷰어 스크립트가 읽는 값 */
function cssPixels(name: string): number {
  return Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name)) || 0;
}

interface Press {
  pageIndex: number;
  spot: BodyBlockSpot;
  clientX: number;
  clientY: number;
}

interface Dragging {
  anchor: BlockAnchor;
  bands: BlockBand[];
  drop: DropSpot | undefined;
}

type MenuItemName = 'up' | 'down' | 'remove';
const MENU_ITEMS: Array<{ name: MenuItemName; label: string }> = [
  { name: 'up', label: '위로' },
  { name: 'down', label: '아래로' },
  { name: 'remove', label: '지우기' },
];

export function setupBlockActions(pagesEl: HTMLElement, host: BlockActionsHost): BlockActions {
  const line = document.createElement('div');
  line.className = 'drop-line';
  line.dataset['testid'] = 'drop-line';
  const menu = createMenu(host);

  /** 이벤트 자리 → 쪽 번호와 쪽 위 점. 캔버스(문서 그림) 위일 때만 — 입력칸·메뉴 위는 아니다 */
  const pointOf = (event: MouseEvent): { pageIndex: number; point: Point } | undefined => {
    const target = event.target;
    if (!(target instanceof HTMLCanvasElement)) return undefined;
    const pageEls = host.pageEls();
    const pageIndex = pageEls.findIndex((pageEl) => pageEl.contains(target));
    const pageEl = pageEls[pageIndex];
    if (pageEl === undefined) return undefined;
    const rect = pageEl.getBoundingClientRect();
    return { pageIndex, point: { x: (event.clientX - rect.left) / host.zoom, y: (event.clientY - rect.top) / host.zoom } };
  };

  // 끌기
  let press: Press | undefined;
  let dragging: Dragging | undefined;

  const stopDrag = () => {
    press = undefined;
    dragging = undefined;
    line.remove();
    document.body.classList.remove('dragging');
  };

  const showDrop = (event: PointerEvent) => {
    if (dragging === undefined) return;
    const at = pointOf(event);
    dragging.drop = at === undefined ? undefined : dropAt(dragging.bands, dragging.anchor, at.pageIndex, at.point.y);
    const drop = dragging.drop;
    const pageEl = drop === undefined ? undefined : host.pageEls()[drop.line.pageIndex];
    if (drop === undefined || pageEl === undefined) {
      line.remove();
      return;
    }
    line.style.left = `${drop.line.x * host.zoom}px`;
    line.style.top = `${drop.line.y * host.zoom}px`;
    line.style.width = `${drop.line.width * host.zoom}px`;
    pageEl.append(line);
  };

  pagesEl.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || menu.open) return;
    const at = pointOf(event);
    const spot = at === undefined ? undefined : host.blockAt(at.pageIndex, at.point);
    if (at === undefined || spot === undefined) return;
    press = { pageIndex: at.pageIndex, spot, clientX: event.clientX, clientY: event.clientY };
  });

  document.addEventListener('pointermove', (event) => {
    if (press !== undefined && dragging === undefined) {
      const moved = Math.hypot(event.clientX - press.clientX, event.clientY - press.clientY);
      if (moved < cssPixels('--drag-threshold')) return;
      dragging = { anchor: press.spot.anchor, bands: host.bands(), drop: undefined };
      document.body.classList.add('dragging');
      window.getSelection()?.removeAllRanges();
    }
    showDrop(event);
  });

  document.addEventListener('pointerup', () => {
    const edit = dragging?.drop?.edit;
    stopDrag();
    if (edit !== undefined) host.send(edit);
  });

  // 오른쪽 클릭 메뉴
  /** 마지막으로 마우스가 올라가 있던 쪽 위 점 — 메뉴 키·Shift+F10 의 대상 블록 */
  let lastPointer: { pageIndex: number; point: Point } | undefined;
  pagesEl.addEventListener('mousemove', (event) => {
    lastPointer = pointOf(event);
  });
  pagesEl.addEventListener('mouseleave', () => {
    lastPointer = undefined;
  });

  pagesEl.addEventListener('contextmenu', (event) => {
    const at = pointOf(event);
    const spot = at === undefined ? undefined : host.blockAt(at.pageIndex, at.point);
    // 블록 밖은 브라우저 메뉴 그대로
    if (spot === undefined) return;
    event.preventDefault();
    stopDrag();
    menu.show(spot.anchor, event.clientX, event.clientY);
  });

  window.addEventListener('keydown', (event) => {
    if (dragging !== undefined && event.key === 'Escape') {
      event.preventDefault();
      stopDrag();
      return;
    }
    const menuKey = event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey);
    if (!menuKey || menu.open) return;
    const target = event.target;
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
    const spot = lastPointer === undefined ? undefined : host.blockAt(lastPointer.pageIndex, lastPointer.point);
    const pageEl = lastPointer === undefined ? undefined : host.pageEls()[lastPointer.pageIndex];
    if (spot === undefined || pageEl === undefined) return;
    event.preventDefault();
    // 블록 왼쪽 아래에 연다
    const rect = pageEl.getBoundingClientRect();
    menu.show(spot.anchor, rect.left + spot.box.x * host.zoom, rect.top + (spot.box.y + spot.box.height) * host.zoom);
  });

  return {
    cancel() {
      stopDrag();
      menu.close(false);
    },
  };
}

interface Menu {
  readonly open: boolean;
  show(anchor: BlockAnchor, clientX: number, clientY: number): void;
  /** restoreFocus: 메뉴를 열기 전 포커스로 돌아간다(Esc·항목 고름) */
  close(restoreFocus: boolean): void;
}

/** role="menu" 메뉴 하나(문서에 하나). 항목은 roving tabindex, 앞·뒤 블록이 없는 항목은 aria-disabled 로 건너뛴다 */
function createMenu(host: BlockActionsHost): Menu {
  const menuEl = document.createElement('div');
  menuEl.className = 'block-menu';
  menuEl.setAttribute('role', 'menu');
  menuEl.setAttribute('aria-label', '블록');
  let edits: MenuEdits | undefined;
  let returnFocus: Element | null = null;

  const items = MENU_ITEMS.map(({ name, label }) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'block-menu-item';
    item.setAttribute('role', 'menuitem');
    item.tabIndex = -1;
    item.textContent = label;
    item.addEventListener('click', () => choose(name));
    menuEl.append(item);
    return { name, item };
  });

  const enabled = () => items.filter(({ item }) => item.getAttribute('aria-disabled') !== 'true').map(({ item }) => item);

  const focusAt = (index: number) => {
    const list = enabled();
    const item = list[(index + list.length) % list.length];
    for (const other of list) other.tabIndex = other === item ? 0 : -1;
    item?.focus();
  };

  const close = (restoreFocus: boolean) => {
    if (edits === undefined) return;
    edits = undefined;
    menuEl.remove();
    if (restoreFocus && returnFocus instanceof HTMLElement) returnFocus.focus();
    returnFocus = null;
  };

  const choose = (name: MenuItemName) => {
    const edit = edits?.[name];
    if (edit === undefined) return;
    close(true);
    host.send(edit);
  };

  menuEl.addEventListener('keydown', (event) => {
    const list = enabled();
    const current = list.findIndex((item) => item === document.activeElement);
    switch (event.key) {
      case 'ArrowDown':
        focusAt(current + 1);
        break;
      case 'ArrowUp':
        focusAt(current - 1);
        break;
      case 'Home':
        focusAt(0);
        break;
      case 'End':
        focusAt(list.length - 1);
        break;
      case 'Escape':
        close(true);
        break;
      case 'Tab':
        close(false);
        return;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
  });

  // 메뉴 밖을 누르면 닫는다
  document.addEventListener(
    'pointerdown',
    (event) => {
      if (edits !== undefined && !(event.target instanceof Node && menuEl.contains(event.target))) close(false);
    },
    true,
  );
  window.addEventListener('scroll', () => close(false));
  window.addEventListener('resize', () => close(false));

  return {
    get open() {
      return edits !== undefined;
    },
    show(anchor, clientX, clientY) {
      if (edits === undefined) returnFocus = document.activeElement;
      edits = host.menuEdits(anchor);
      for (const { name, item } of items) {
        if (edits[name] === undefined) item.setAttribute('aria-disabled', 'true');
        else item.removeAttribute('aria-disabled');
      }
      document.body.append(menuEl);
      // 화면 밖으로 나가지 않게 당긴다
      const { width, height } = menuEl.getBoundingClientRect();
      menuEl.style.left = `${Math.max(0, Math.min(clientX, window.innerWidth - width))}px`;
      menuEl.style.top = `${Math.max(0, Math.min(clientY, window.innerHeight - height))}px`;
      focusAt(0);
    },
    close,
  };
}
