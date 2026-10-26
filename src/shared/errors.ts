// 서버·뷰어가 같이 쓰는 오류 문구 꺼내기.

/** 던져진 값에서 사용자에게 보일 문구. Error 면 message, 아니면 문자열로 */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
