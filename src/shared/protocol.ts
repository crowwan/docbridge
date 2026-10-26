// 서버 → 뷰어 WebSocket 메시지. 기술 검증 단계에서는 연결 확인용 ping 만 있다.
export interface PingMessage {
  type: 'ping';
  at: number;
}

export type ServerMessage = PingMessage;
