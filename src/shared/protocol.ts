// 서버 ↔ 뷰어 WebSocket 프로토콜.
// 서버가 요청(request)을 보내고 뷰어가 같은 id 로 응답(response)한다. 메시지는 JSON 문자열이고,
// 받는 쪽은 아래 zod 스키마로 읽는다(타입 단언 없이).
import { z } from 'zod';
import { blockPositionSchema, blockSchema } from '../core/block-schema.ts';
import { textMatchSchema } from '../core/find-text.ts';

/** 뷰어가 이 시간 안에 응답하지 않으면 요청을 실패로 끝낸다 */
export const REQUEST_TIMEOUT_MS = 30_000;

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

/** 서버가 뷰어에 부르는 메서드와 입력·결과 스키마 */
export const viewerMethodSchemas = {
  /** 문서를 열어 렌더링하고 블록을 추출한다. 이전 문서는 닫는다 */
  load_document: { params: loadDocumentParamsSchema, result: loadDocumentResultSchema },
  /** 열린 문서의 블록 전문(문서 순서). 열 때 뽑아 둔 것 */
  get_blocks: { params: z.object({}), result: z.array(blockSchema) },
  /** 문단·표 칸에서 query 와 일치하는 위치 */
  find_text: { params: z.object({ query: z.string() }), result: z.array(textMatchSchema) },
} as const;

type MethodSchemas = typeof viewerMethodSchemas;
export type ViewerMethod = keyof MethodSchemas;
export type ViewerParams<M extends ViewerMethod> = z.infer<MethodSchemas[M]['params']>;
export type ViewerResult<M extends ViewerMethod> = z.infer<MethodSchemas[M]['result']>;
export type LoadDocumentParams = ViewerParams<'load_document'>;
export type LoadDocumentResult = ViewerResult<'load_document'>;

/** 서버가 뷰어 응답의 결과를 메서드 M 의 결과 타입으로 읽는다 */
export const parseViewerResult: { [M in ViewerMethod]: (result: unknown) => ViewerResult<M> } = {
  load_document: (result) => viewerMethodSchemas.load_document.result.parse(result),
  get_blocks: (result) => viewerMethodSchemas.get_blocks.result.parse(result),
  find_text: (result) => viewerMethodSchemas.find_text.result.parse(result),
};

const requestSchema = <M extends ViewerMethod, P extends z.ZodType>(method: M, params: P) =>
  z.object({ type: z.literal('request'), id: z.number(), method: z.literal(method), params });

/** 뷰어가 요청을 읽는 스키마. 메서드마다 입력 모양이 다르다(메서드를 더하면 여기에도 더한다) */
export const requestMessageSchema = z.discriminatedUnion('method', [
  requestSchema('load_document', viewerMethodSchemas.load_document.params),
  requestSchema('get_blocks', viewerMethodSchemas.get_blocks.params),
  requestSchema('find_text', viewerMethodSchemas.find_text.params),
]);
export type RequestMessage = z.infer<typeof requestMessageSchema>;

export const responseMessageSchema = z.union([
  z.object({ type: z.literal('response'), id: z.number(), ok: z.literal(true), result: z.unknown() }),
  z.object({ type: z.literal('response'), id: z.number(), ok: z.literal(false), error: z.string() }),
]);
export type ResponseMessage = z.infer<typeof responseMessageSchema>;

const unknownRequestSchema = z.object({ id: z.number(), method: z.string() });

/**
 * 뷰어가 받은 메시지를 handle 로 처리해 돌려보낼 응답을 만든다.
 * 메서드를 모르거나 입력이 맞지 않아도 id 가 있으면 오류로 응답한다(조용히 버리면 서버가 타임아웃까지 기다린다).
 * 요청 모양이 아니면 undefined
 */
export function answerRequest(raw: string, handle: (request: RequestMessage) => unknown): ResponseMessage | undefined {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const parsed = requestMessageSchema.safeParse(data);
  if (!parsed.success) {
    const loose = unknownRequestSchema.safeParse(data);
    if (!loose.success) return undefined;
    const { id, method } = loose.data;
    return { type: 'response', id, ok: false, error: `뷰어가 읽을 수 없는 요청입니다(${method}). docbridge 를 다시 띄우고 뷰어 탭을 새로고침하세요.` };
  }
  const { id } = parsed.data;
  try {
    return { type: 'response', id, ok: true, result: handle(parsed.data) };
  } catch (error) {
    return { type: 'response', id, ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

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
