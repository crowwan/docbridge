// 서버 ↔ 뷰어 WebSocket 프로토콜.
// 서버가 요청(request)을 보내고 뷰어가 같은 id 로 응답(response)한다. 메시지는 JSON 문자열이고,
// 받는 쪽은 아래 zod 스키마로 읽는다(타입 단언 없이).
import { z } from 'zod';
import {
  anchoredTargetSchema,
  blockPositionSchema,
  blockAnchorSchema,
  blockSchema,
  textTargetSchema,
  type AnchoredTarget,
  type TextTarget,
} from '../core/block-schema.ts';
import { editOperationSchema } from '../core/edit-operations.ts';
import { textMatchSchema } from '../core/find-text.ts';
import { paragraphChangesSchema } from '../core/paragraph-changes.ts';
import { saveExportSchema } from '../core/hwpx-export.ts';
import { errorMessage } from './errors.ts';

// 하이라이트·찾기·편집 공용 대상(TextTarget)과 서버가 위치를 붙인 대상은 core/block-schema.ts 에 있다(뷰어 편집 코드가 같이 쓴다)
export { anchoredTargetSchema, blockAnchorSchema, textTargetSchema, type AnchoredTarget, type TextTarget };

/** highlight note 의 최대 글자 수. 하이라이트 옆에 짧게 붙는 말이다 */
export const NOTE_MAX_CHARS = 100;

export const highlightParamsSchema = z.object({
  /** 서버가 id 를 위치로 바꿔 붙인 대상. 첫 대상으로 스크롤한다 */
  targets: z.array(anchoredTargetSchema).min(1),
  note: z.string().optional(),
});

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

/** 새 문서 만들기(SPEC-003): 새 문서 이름(상태 줄), 양식이 있으면 그 바이트(base64)와 본문을 남길지 */
export const createDocumentParamsSchema = z.object({
  fileName: z.string(),
  template: z.object({ fileName: z.string(), data: z.string(), keepContent: z.boolean() }).optional(),
});

const objectCountsSchema = z.record(z.string(), z.number());

/** 만든 새 문서: 쪽 수, 블록 위치(첫 문단은 비어 있어도 블록), 문단 스타일, 양식을 비웠으면 지운 개체·남긴 개체 이름별 수 */
export const createDocumentResultSchema = z.object({
  pageCount: z.number(),
  blocks: z.array(blockPositionSchema),
  styles: z.array(z.object({ name: z.string(), englishName: z.string(), outlineLevel: z.number().optional() })),
  cleared: z.object({ removedObjects: objectCountsSchema, keptObjects: objectCountsSchema }).optional(),
});

/**
 * 편집 결과: 바뀐 블록(편집 뒤 위치와 내용), 화면에 표시하지 못한 블록, 다시 그린 쪽 수,
 * 문단 수를 바꾼 편집이면 실제로 넣고 지운 문단·표(서버는 이것으로 id 표를 옮긴다 — core/paragraph-changes.ts)
 */
export const editResultSchema = z.object({
  changed: z.array(z.object({ anchor: blockAnchorSchema, block: blockSchema })),
  unmarked: z.array(blockAnchorSchema),
  pageCount: z.number(),
  changes: paragraphChangesSchema.optional(),
});

/** 서버가 아는 편집 순번(연 뒤 적용한 편집 수 − 되돌린 수). 뷰어 순번과 다르면 뷰어는 아무것도 하지 않고 거부한다 */
const depthSchema = z.number().int().min(0);

/**
 * 이 요청이 성공한 뒤의 저장하지 않은 편집 수(서버 EditLog 가 미리 계산). 뷰어는 성공하면 이 값으로 탭 닫기 확인 창을 정한다 —
 * 편집·되돌리기 뒤에 edit_state 를 따로 보내는 왕복을 줄인다
 */
const unsavedEditsSchema = z.number().int().min(0);

/** 서버가 뷰어에 부르는 메서드와 입력·결과 스키마 */
export const viewerMethodSchemas = {
  /** 문서를 열어 렌더링하고 블록을 추출한다. 이전 문서는 닫는다 */
  load_document: { params: loadDocumentParamsSchema, result: loadDocumentResultSchema },
  /** 새 문서(빈 문서 또는 양식)를 뷰어가 rhwp 로 만들어 렌더링하고 블록을 추출한다. 이전 문서는 닫는다. 서버는 새 문서 바이트를 갖지 않는다 */
  create_document: { params: createDocumentParamsSchema, result: createDocumentResultSchema },
  /** 열린 문서의 블록 전문(문서 순서). 열 때 뽑아 둔 것 */
  get_blocks: { params: z.object({}), result: z.array(blockSchema) },
  /** 문단·표 칸에서 query 와 일치하는 위치 */
  find_text: { params: z.object({ query: z.string() }), result: z.array(textMatchSchema) },
  /** 이전 하이라이트를 지우고 대상마다 하이라이트를 그린 뒤 첫 대상으로 스크롤한다. 결과는 하이라이트가 있는 모든 쪽(1부터, 오름차순)과 정확하지 않을 수 있는 대상 안내 */
  highlight: { params: highlightParamsSchema, result: z.object({ pages: z.array(z.number()), warnings: z.array(z.string()).optional() }) },
  /** 하이라이트를 모두 지운다 */
  clear_highlight: { params: z.object({}), result: z.object({}) },
  /**
   * 편집 공용 경로(SPEC-002): 스냅샷 → 편집 → 다시 그리기 → 블록 다시 뽑기 → 바뀐 블록 표시(이전 표시·하이라이트는 지워진다).
   * 다시 그리기·표시까지 성공해야 기록에 들어가고, 실패하면 스냅샷으로 되돌려 문서는 그대로다. 편집 종류는 operation.kind(core/edit-operations.ts)
   */
  edit: { params: z.object({ operation: editOperationSchema, depth: depthSchema, unsavedEdits: unsavedEditsSchema }), result: editResultSchema },
  /** 스냅샷으로 steps 만큼(있는 만큼만) 되돌리고 다시 그린다. 결과는 되돌린 수(없으면 0) */
  undo: {
    // unsavedEdits 는 steps 를 다 되돌렸을 때의 값. 덜 되돌렸으면 뷰어는 쓰지 않고 서버가 edit_state 로 맞춘다
    params: z.object({ steps: z.number().int().min(1), depth: depthSchema, unsavedEdits: unsavedEditsSchema }),
    result: z.object({ undone: z.number(), pageCount: z.number() }),
  },
  /** 지금 문서를 HWPX 로 내보내 다시 열어 비교한다(저장 전 검증). 같을 때만 바이트(base64)를 싣는다. 50MB 를 넘으면 오류 */
  export_hwpx: { params: z.object({}), result: saveExportSchema },
  /**
   * 서버 편집 기록의 상태를 뷰어에 맞춘다(저장 뒤, 되돌리기가 덜 되돌렸을 때). 뷰어는 unsavedEdits 가 0 이 아니면 탭을 닫거나 새로고침할 때
   * 확인 창을 띄우고, 상태 줄을 마지막 파일 이름으로 둔다. 저장하지 않은 편집 수는 서버(EditLog)만 센다
   */
  // newDocument: 한 번도 저장하지 않은 새 문서(SPEC-003). 편집이 없어도 확인 창을 띄운다
  edit_state: {
    params: z.object({ fileName: z.string(), unsavedEdits: z.number().int().min(0), newDocument: z.boolean() }),
    result: z.object({}),
  },
} as const;

type MethodSchemas = typeof viewerMethodSchemas;
export type ViewerMethod = keyof MethodSchemas;
export type ViewerParams<M extends ViewerMethod> = z.infer<MethodSchemas[M]['params']>;
export type ViewerResult<M extends ViewerMethod> = z.infer<MethodSchemas[M]['result']>;
export type LoadDocumentParams = ViewerParams<'load_document'>;
export type LoadDocumentResult = ViewerResult<'load_document'>;
export type CreateDocumentResult = ViewerResult<'create_document'>;

/** 서버가 뷰어 응답의 결과를 메서드 M 의 결과 타입으로 읽는다 */
export const parseViewerResult: { [M in ViewerMethod]: (result: unknown) => ViewerResult<M> } = {
  load_document: (result) => viewerMethodSchemas.load_document.result.parse(result),
  create_document: (result) => viewerMethodSchemas.create_document.result.parse(result),
  get_blocks: (result) => viewerMethodSchemas.get_blocks.result.parse(result),
  find_text: (result) => viewerMethodSchemas.find_text.result.parse(result),
  highlight: (result) => viewerMethodSchemas.highlight.result.parse(result),
  clear_highlight: (result) => viewerMethodSchemas.clear_highlight.result.parse(result),
  edit: (result) => viewerMethodSchemas.edit.result.parse(result),
  undo: (result) => viewerMethodSchemas.undo.result.parse(result),
  export_hwpx: (result) => viewerMethodSchemas.export_hwpx.result.parse(result),
  edit_state: (result) => viewerMethodSchemas.edit_state.result.parse(result),
};

const requestSchema = <M extends ViewerMethod, P extends z.ZodType>(method: M, params: P) =>
  z.object({ type: z.literal('request'), id: z.number(), method: z.literal(method), params });

/** 메서드별 요청 스키마. viewerMethodSchemas 의 메서드를 하나라도 빠뜨리면 satisfies 에서 컴파일 오류가 난다 */
const requestSchemas = {
  load_document: requestSchema('load_document', viewerMethodSchemas.load_document.params),
  create_document: requestSchema('create_document', viewerMethodSchemas.create_document.params),
  get_blocks: requestSchema('get_blocks', viewerMethodSchemas.get_blocks.params),
  find_text: requestSchema('find_text', viewerMethodSchemas.find_text.params),
  highlight: requestSchema('highlight', viewerMethodSchemas.highlight.params),
  clear_highlight: requestSchema('clear_highlight', viewerMethodSchemas.clear_highlight.params),
  edit: requestSchema('edit', viewerMethodSchemas.edit.params),
  undo: requestSchema('undo', viewerMethodSchemas.undo.params),
  export_hwpx: requestSchema('export_hwpx', viewerMethodSchemas.export_hwpx.params),
  edit_state: requestSchema('edit_state', viewerMethodSchemas.edit_state.params),
} satisfies { [M in ViewerMethod]: z.ZodObject };

/** 뷰어가 요청을 읽는 스키마. 메서드마다 입력 모양이 다르다 */
export const requestMessageSchema = z.discriminatedUnion('method', [
  requestSchemas.load_document,
  requestSchemas.create_document,
  requestSchemas.get_blocks,
  requestSchemas.find_text,
  requestSchemas.highlight,
  requestSchemas.clear_highlight,
  requestSchemas.edit,
  requestSchemas.undo,
  requestSchemas.export_hwpx,
  requestSchemas.edit_state,
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
