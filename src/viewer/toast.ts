// 뷰어 아래 알림(토스트, SPEC-006): 사람 편집이 안 된 이유를 잠깐 보여 준다. 끌어 옮기기·오른쪽 클릭(#60)도 이것으로 알린다.
// 한 번에 하나만 — 새 문구가 오면 바꿔 끼우고 시간을 다시 센다(개인 DS PATTERNS F1). 시간은 tokens.css --toast-duration
const toastEl = document.getElementById('toast');
let hideTimer: ReturnType<typeof setTimeout> | undefined;

/** --toast-duration(ms 또는 s) */
function toastDuration(): number {
  const value = getComputedStyle(document.documentElement).getPropertyValue('--toast-duration').trim();
  const amount = Number.parseFloat(value);
  return value.endsWith('ms') ? amount : amount * 1000;
}

export function showToast(message: string): void {
  if (toastEl === null) return;
  toastEl.textContent = message;
  toastEl.hidden = false;
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    toastEl.hidden = true;
  }, toastDuration());
}
