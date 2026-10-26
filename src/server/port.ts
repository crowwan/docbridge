// 포트 환경 변수 해석. 서버 시작 포트(DOCBRIDGE_PORT)와 E2E 개발 서버 포트(DOCBRIDGE_E2E_PORT, playwright.config.ts)가 같이 쓴다.

/** 사용 중이면 7791, 7792 … 로 넘어간다(bridge.ts PORT_ATTEMPTS) */
export const DEFAULT_PORT = 7790;
const MAX_PORT = 65535;

/** 비어 있으면 기본 포트. 0 은 빈 포트 아무거나(테스트용). 숫자가 아니거나 범위 밖이면 변수 이름과 함께 던진다 */
export function portFromEnv(value: string | undefined, name = 'DOCBRIDGE_PORT', defaultPort = DEFAULT_PORT): number {
  // Number('') 는 0(아무 포트)이 되므로 빈 값은 먼저 거른다
  if (value === undefined || value.trim() === '') return defaultPort;
  const port = Number(value);
  if (!/^\d+$/.test(value.trim()) || port > MAX_PORT) {
    throw new Error(`${name} 가 올바른 포트 번호가 아닙니다: ${value}`);
  }
  return port;
}
