// 서버 ↔ 뷰어 WebSocket 프로토콜.
// 서버가 요청(request)을 보내고 뷰어가 같은 id 로 응답(response)한다. 메시지는 JSON 문자열이고,
// 받는 쪽은 아래 zod 스키마로 읽는다(타입 단언 없이).
import { z } from 'zod';

/** 뷰어가 이 시간 안에 응답하지 않으면 요청을 실패로 끝낸다 */
export const REQUEST_TIMEOUT_MS = 30_000;

// 블록 id 표를 만드는 데 필요한 블록 위치(core/block-ids.ts 의 BlockPosition)
export const blockPositionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('paragraph'), section: z.number(), paragraph: z.number() }),
  z.object({ kind: z.literal('table'), section: z.number(), paragraph: z.number(), controlIndex: z.number() }),
  z.object({ kind: z.literal('field'), section: z.number(), paragraph: z.number() }),
]);

export const loadDocumentParamsSchema = z.object({
  fileName: z.string(),
  /** 파일 바이트(base64) */
  data: z.string(),
});

export const loadDocumentResultSchema = z.object({
  pageCount: z.number(),
  /** 문서 순서대로의 블록 위치 */
  blocks: z.array(blockPositionSchema),
});

/** 서버가 뷰어에 부르는 메서드와 입력·결과 */
export const viewerMethods = {
  /** 문서를 열어 렌더링하고 블록을 추출한다. 이전 문서는 닫는다 */
  load_document: { params: loadDocumentParamsSchema, result: loadDocumentResultSchema },
} as const;

export type ViewerMethod = keyof typeof viewerMethods;
export type ViewerParams<M extends ViewerMethod> = z.infer<(typeof viewerMethods)[M]['params']>;
export type ViewerResult<M extends ViewerMethod> = z.infer<(typeof viewerMethods)[M]['result']>;

export const requestMessageSchema = z.object({
  type: z.literal('request'),
  id: z.number(),
  method: z.literal('load_document'),
  params: loadDocumentParamsSchema,
});
export type RequestMessage = z.infer<typeof requestMessageSchema>;

export const responseMessageSchema = z.union([
  z.object({ type: z.literal('response'), id: z.number(), ok: z.literal(true), result: z.unknown() }),
  z.object({ type: z.literal('response'), id: z.number(), ok: z.literal(false), error: z.string() }),
]);
export type ResponseMessage = z.infer<typeof responseMessageSchema>;

export const timeoutMessage = (method: string, timeoutMs: number) =>
  `뷰어가 ${timeoutMs / 1000}초 안에 응답하지 않았습니다(${method}). 뷰어 탭을 확인하고 다시 시도하세요.`;

interface Pending {
  settle(response: ResponseMessage): void;
  fail(error: Error): void;
}

/** 보낸 요청을 id 로 기억했다가 응답·타임아웃·연결 끊김 중 먼저 온 것으로 끝낸다 */
export class RequestTracker {
  private readonly pending = new Map<number, Pending>();
  private readonly timeoutMs: number;
  private nextId = 1;

  constructor(timeoutMs = REQUEST_TIMEOUT_MS) {
    this.timeoutMs = timeoutMs;
  }

  /** 새 요청 id 와, 응답 결과를 parse 로 읽어 풀리는 Promise */
  start<T>(method: string, parse: (result: unknown) => T): { id: number; promise: Promise<T> } {
    const id = this.nextId;
    this.nextId += 1;
    const promise = new Promise<T>((resolve, reject) => {
      const finish = () => {
        clearTimeout(timer);
        this.pending.delete(id);
      };
      const timer = setTimeout(() => {
        finish();
        reject(new Error(timeoutMessage(method, this.timeoutMs)));
      }, this.timeoutMs);
      this.pending.set(id, {
        settle: (response) => {
          finish();
          if (!response.ok) {
            reject(new Error(response.error));
            return;
          }
          try {
            resolve(parse(response.result));
          } catch (error) {
            reject(new Error(`뷰어 응답을 읽지 못했습니다(${method}): ${String(error)}`));
          }
        },
        fail: (error) => {
          finish();
          reject(error);
        },
      });
    });
    return { id, promise };
  }

  /** 응답을 해당 요청에 넘긴다. 이미 끝난(타임아웃 등) 요청의 응답은 무시한다 */
  settle(response: ResponseMessage): void {
    this.pending.get(response.id)?.settle(response);
  }

  failAll(error: Error): void {
    for (const pending of [...this.pending.values()]) pending.fail(error);
  }

  pendingCount(): number {
    return this.pending.size;
  }
}

// 기술 검증(#4)의 연결 확인용 메시지
export interface PingMessage {
  type: 'ping';
  at: number;
}

export type ServerMessage = PingMessage | RequestMessage;
