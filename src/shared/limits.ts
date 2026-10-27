// 서버·뷰어가 같이 쓰는 크기 상한.
export const MB = 1024 * 1024;

/**
 * 열기·저장하는 문서 파일의 최대 크기. 서버 ↔ 뷰어는 파일 바이트를 base64 JSON 으로 주고받는다(약 1.34배, 50MB → 67MB).
 * ws 의 메시지 상한(기본 100MB) 안에 들어간다. 바이너리 프레임은 v0.2 메모(#8)
 */
export const MAX_DOCUMENT_BYTES = 50 * MB;

/** 저장할 문서가 상한을 넘을 때(뷰어 내보내기·서버 받기 공용) */
export const tooLargeMessage = (bytes: number, maxBytes: number) =>
  `저장할 문서가 너무 큽니다(${Math.ceil(bytes / MB)}MB). ${Math.floor(maxBytes / MB)}MB 까지 저장할 수 있습니다.`;

/** n 바이트를 base64 로 쓴 글자 수 */
export const base64Length = (bytes: number) => Math.ceil(bytes / 3) * 4;
