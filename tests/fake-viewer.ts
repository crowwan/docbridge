// 테스트용 가짜 뷰어: 토큰 주소로 WebSocket 에 붙어 서버 요청을 받고, 원하는 결과로 응답한다.
import { WebSocket } from 'ws';
import { requestMessageSchema, type RequestMessage, type ViewerResult } from '../src/shared/protocol.ts';

export class FakeViewer {
  private readonly ws: WebSocket;
  private readonly received: RequestMessage[] = [];
  private readonly waiters: Array<(request: RequestMessage) => void> = [];
  /** 받은 요청 전부(순서대로) */
  readonly history: RequestMessage[] = [];
  private autoResult: ViewerResult<'load_document'> | undefined;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on('message', (data) => {
      const request = requestMessageSchema.parse(JSON.parse(String(data)));
      this.history.push(request);
      if (this.autoResult !== undefined) {
        this.respond(request.id, this.autoResult);
        return;
      }
      const waiter = this.waiters.shift();
      if (waiter) waiter(request);
      else this.received.push(request);
    });
  }

  static connect(viewerUrl: string): Promise<FakeViewer> {
    const ws = new WebSocket(viewerUrl.replace('http://', 'ws://'));
    return new Promise((resolve, reject) => {
      ws.once('open', () => resolve(new FakeViewer(ws)));
      ws.once('error', reject);
    });
  }

  /** 서버가 보낸 다음 요청(이미 와 있으면 그것) */
  nextRequest(): Promise<RequestMessage> {
    const queued = this.received.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  /** 이후 오는 요청마다 바로 이 결과로 응답한다 */
  autoRespond(result: ViewerResult<'load_document'>): void {
    this.autoResult = result;
  }

  respond(id: number, result: ViewerResult<'load_document'>): void {
    this.ws.send(JSON.stringify({ type: 'response', id, ok: true, result }));
  }

  fail(id: number, error: string): void {
    this.ws.send(JSON.stringify({ type: 'response', id, ok: false, error }));
  }

  close(): void {
    this.ws.close();
  }
}

/** 블록 위치 n 개(문단만) — 가짜 뷰어 응답용 */
export const paragraphBlocks = (count: number) =>
  Array.from({ length: count }, (_, i) => ({ kind: 'paragraph' as const, section: 0, paragraph: i }));
