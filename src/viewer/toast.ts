// 뷰어 아래 알림(토스트, SPEC-006): 사람 편집이 안 된 이유를 잠깐 보여 준다. 끌어 옮기기·오른쪽 클릭(#60)도 이것으로 알린다.
// PDF 버튼(SPEC-008 AC-7)은 저장한 경로(성공)도 이것으로 알린다 — 한 번에 하나라 성공과 실패가 같은 자리를 쓴다.
// 한 번에 하나만 — 새 문구가 오면 바꿔 끼우고 시간을 다시 센다(개인 DS PATTERNS F1). 시간은 tokens.css --toast-duration.
// 종류(data-kind)는 왼쪽 선 색만 가른다: 실패 = --danger, 성공 = --toast-success-accent(초록) — 색만이 아니라 문장으로도 갈린다.
// 알림 칸(role="alert")은 숨기지 않고 늘 두고 글자만 넣고 비운다 — 숨겼다 보이면 화면 읽기 도구가 읽지 않을 수 있다.
// 문구는 매번 새 요소로 넣어, 3초 안에 같은 문구가 다시 와도 새로 더한 내용으로 읽힌다
const toastEl = document.getElementById('toast');
let hideTimer: ReturnType<typeof setTimeout> | undefined;

export type ToastKind = 'error' | 'success';

/** --toast-duration(ms 또는 s) */
function toastDuration(): number {
  const value = getComputedStyle(document.documentElement).getPropertyValue('--toast-duration').trim();
  const amount = Number.parseFloat(value);
  return value.endsWith('ms') ? amount : amount * 1000;
}

export function showToast(message: string, kind: ToastKind = 'error'): void {
  if (toastEl === null) return;
  const line = document.createElement('span');
  line.textContent = message;
  toastEl.dataset['kind'] = kind;
  toastEl.replaceChildren(line);
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => toastEl.replaceChildren(), toastDuration());
}
