// 바이트 ↔ base64. 브라우저(뷰어)와 Node(테스트 뷰어) 둘 다에서 돈다(btoa·atob 는 둘 다 있다).

/** 한 번에 String.fromCharCode 에 넘기는 바이트 수(인자가 너무 많으면 스택이 넘친다) */
const CHUNK = 0x8000;

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(binary);
}

export function base64ToBytes(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
