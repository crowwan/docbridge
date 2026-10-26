// stdout 은 MCP stdio 전송 전용이다. 로그는 반드시 stderr 로 보낸다.
export function log(message: string): void {
  process.stderr.write(`[docbridge] ${message}\n`);
}
