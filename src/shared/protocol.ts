// 서버 ↔ 뷰어 WebSocket 프로토콜.
// 서버가 요청(request)을 보내고 뷰어가 같은 id 로 응답(response)한다. 메시지는 JSON 문자열이고,
// 받는 쪽은 아래 zod 스키마로 읽는다(타입 단언 없이).
import { z } from 'zod';
import { blockPositionSchema, blockSchema } from '../core/block-schema.ts';
import { textMatchSchema } from '../core/find-text.ts';
import { errorMessage } from './errors.ts';

/**
 * 하이라이트·찾기 공용 대상(#6 find_text 결과, #7 highlight 입력).
 * 글자 위치는 read_blocks 가 돌려주는 블록 text(표는 칸 안 문단을 \n 으로 이은 칸 text) 안 유니코드 글자 위치다
 * (JS 문자열 위치가 아니다. 이모지·확장 한자도 한 글자 — core/chars.ts).
 */
export const textTargetSchema = z.object({
  /** 블록 id */
  id: z.string(),
  /** 표 블록일 때 칸(0부터). 표 블록인데 없으면 표 전체 */
  cell: z.object({ row: z.number().int().min(0), col: z.number().int().min(0) }).optional(),
  /** 블록(또는 칸) 텍스트 안 시작 글자 위치. 0부터, 포함 */
  start: z.number().int().min(0).optional(),
  /** 끝 글자 위치, 미포함. start·end 둘 다 없으면 블록(칸) 전체 */
  end: z.number().int().min(0).optional(),
});
export type TextTarget = z.infer<typeof textTargetSchema>;

/** highlight note 의 최대 글자 수. 하이라이트 옆에 짧게 붙는 말이다 */
export const NOTE_MAX_CHARS = 100;

/** 서버 id 표가 기억하는 블록 위치(core/block-ids.ts BlockAnchor). 뷰어가 이것으로 자기 블록을 찾는다 */
export const blockAnchorSchema = z.object({ section: z.number(), paragraph: z.number(), part: z.string() });

export const highlightParamsSchema = z.object({
  /** 서버가 id 를 위치로 바꿔 붙인 대상. 첫 대상으로 스크롤한다 */
  targets: z.array(textTargetSchema.extend({ anchor: blockAnchorSchema })).min(1),
  note: z.string().optional(),
});
export type AnchoredTarget = z.infer<typeof highlightParamsSchema>['targets'][number];

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
  /** 이전 하이라이트를 지우고 대상마다 하이라이트를 그린 뒤 첫 대상으로 스크롤한다. 결과는 대상마다 첫 사각형의 쪽(1부터) */
  highlight: { params: highlightParamsSchema, result: z.object({ pages: z.array(z.number()) }) },
  /** 하이라이트를 모두 지운다 */
  clear_highlight: { params: z.object({}), result: z.object({}) },
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
  highlight: (result) => viewerMethodSchemas.highlight.result.parse(result),
  clear_highlight: (result) => viewerMethodSchemas.clear_highlight.result.parse(result),
};

const requestSchema = <M extends ViewerMethod, P extends z.ZodType>(method: M, params: P) =>
  z.object({ type: z.literal('request'), id: z.number(), method: z.literal(method), params });

/** 메서드별 요청 스키마. viewerMethodSchemas 의 메서드를 하나라도 빠뜨리면 satisfies 에서 컴파일 오류가 난다 */
const requestSchemas = {
  load_document: requestSchema('load_document', viewerMethodSchemas.load_document.params),
  get_blocks: requestSchema('get_blocks', viewerMethodSchemas.get_blocks.params),
  find_text: requestSchema('find_text', viewerMethodSchemas.find_text.params),
  highlight: requestSchema('highlight', viewerMethodSchemas.highlight.params),
  clear_highlight: requestSchema('clear_highlight', viewerMethodSchemas.clear_highlight.params),
} satisfies { [M in ViewerMethod]: z.ZodObject };

/** 뷰어가 요청을 읽는 스키마. 메서드마다 입력 모양이 다르다 */
export const requestMessageSchema = z.discriminatedUnion('method', [
  requestSchemas.load_document,
  requestSchemas.get_blocks,
  requestSchemas.find_text,
  requestSchemas.highlight,
  requestSchemas.clear_highlight,
]);
export type RequestMessage = z.infer<typeof requestMessageSchema>;

// 유니언에 빠진 메서드가 있으면 여기서 컴파일 오류가 난다(런타임 "읽을 수 없는 요청" 대신)
type MissingRequestMethod = Exclude<ViewerMethod, RequestMessage['method']>;
const everyMethodHasRequestSchema: [MissingRequestMethod] extends [never] ? true : MissingRequestMethod = true;
void everyMethodHasRequestSchema;

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
    return { type: 'response', id, ok: false, error: errorMessage(error) };
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
