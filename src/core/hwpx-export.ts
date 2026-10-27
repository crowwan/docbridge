// HWPX 내보내기와 저장 전 검증 — SPEC-002 기술 검증(#18).
// 내보낸 바이트를 rhwp 로 다시 열어 블록(위치·글자·번호)이 지금 문서와 같은지 본다. 다르면 쓰지 않는다(AC-10).
// 보고서(exportHwpxWithReport().contentLoss())에 손실이 있으면 경고로 돌려준다.
import { HwpDocument } from '@rhwp/core';
import { z } from 'zod';
import { bytesToBase64 } from '../shared/base64.ts';
import { errorMessage } from '../shared/errors.ts';
import { MAX_DOCUMENT_BYTES, tooLargeMessage } from '../shared/limits.ts';
import { blockPositionSchema, type Block } from './block-schema.ts';
import { extractBlocks } from './blocks.ts';

// rhwp src/serializer/content_loss.rs ContentLoss (code·subject·path·reason·resourceId?)
export const contentLossItemSchema = z.object({
  code: z.string(),
  subject: z.string(),
  path: z.string(),
  reason: z.string(),
  resourceId: z.number().optional(),
});

const contentLossSchema = z.object({
  schemaVersion: z.number(),
  outputFormat: z.string(),
  count: z.number(),
  losses: z.array(contentLossItemSchema),
});

export type ContentLoss = z.infer<typeof contentLossItemSchema>;

/** 블록 비교용 내용. 쪽(page)은 조판 결과라 빼고, 위치·글자·번호·칸·누름틀 값을 본다 */
export function blockContent(block: Block): string {
  switch (block.kind) {
    case 'paragraph':
      return JSON.stringify(['p', block.section, block.paragraph, block.text, block.number ?? null, block.outlineLevel ?? null]);
    case 'table':
      return JSON.stringify(['t', block.section, block.paragraph, block.controlIndex, block.rowCount, block.colCount, block.cells]);
    case 'field':
      return JSON.stringify(['f', block.section, block.paragraph, block.name, block.value]);
  }
}

/** 두 블록 목록에서 달라진 자리(지금 문서 기준 순서). 수가 다르면 짧은 쪽 끝 다음부터 모두 다르다고 본다 */
export function differentBlocks(expected: Block[], actual: Block[]): number[] {
  const length = Math.max(expected.length, actual.length);
  const different: number[] = [];
  for (let i = 0; i < length; i += 1) {
    const a = expected[i];
    const b = actual[i];
    if (a === undefined || b === undefined || blockContent(a) !== blockContent(b)) different.push(i);
  }
  return different;
}

export interface VerifiedExport {
  bytes: Uint8Array;
  losses: ContentLoss[];
  /** 지금 문서 블록 순서 기준으로 다시 연 문서와 달라진 블록 자리. 비었으면 같다. 다시 열지 못하면 모든 자리 */
  different: number[];
  /** 내보낸 바이트를 rhwp 가 다시 열지 못한 이유(AC-10: 검증 실패로 보고 파일을 쓰지 않는다) */
  reopenError?: string;
  timings: { exportMs: number; reopenMs: number; compareMs: number };
}

/** 내보낸 바이트를 다시 여는 방법(테스트에서 실패를 흉내낼 때 바꾼다) */
export type Reopen = (bytes: Uint8Array) => HwpDocument;

const reopenWithRhwp: Reopen = (bytes) => new HwpDocument(bytes);

/** 지금 문서를 HWPX 로 내보내고 다시 열어 비교한다. current 를 주면 지금 문서 블록을 다시 뽑지 않는다 */
export function exportVerifiedHwpx(
  doc: HwpDocument,
  current: Block[] = extractBlocks(doc),
  reopen: Reopen = reopenWithRhwp,
): VerifiedExport {
  const t0 = performance.now();
  const exported = doc.exportHwpxWithReport();
  let bytes: Uint8Array;
  let losses: ContentLoss[];
  try {
    losses = contentLossSchema.parse(JSON.parse(exported.contentLoss())).losses;
    bytes = exported.takeBytes();
  } finally {
    exported.free();
  }
  const t1 = performance.now();
  let reopened: HwpDocument;
  try {
    reopened = reopen(bytes);
  } catch (error) {
    const t2 = performance.now();
    return {
      bytes,
      losses,
      different: current.map((_, i) => i),
      reopenError: errorMessage(error),
      timings: { exportMs: t1 - t0, reopenMs: t2 - t1, compareMs: 0 },
    };
  }
  const t2 = performance.now();
  try {
    const different = differentBlocks(current, extractBlocks(reopened));
    const t3 = performance.now();
    return { bytes, losses, different, timings: { exportMs: t1 - t0, reopenMs: t2 - t1, compareMs: t3 - t2 } };
  } finally {
    reopened.free();
  }
}

/**
 * 뷰어 export_hwpx 의 결과(서버로 간다). 검증을 통과해야만 바이트(base64)가 실린다(AC-10: 다르면 파일을 쓰지 않는다).
 * blocks 는 지금 문서의 블록 위치(문서 순서) — 서버가 id 를 붙이고, 저장하면 새로고침 때 비교할 기준으로 들고 있는다
 */
export const saveExportSchema = z.discriminatedUnion('verified', [
  z.object({
    verified: z.literal(true),
    data: z.string(),
    byteLength: z.number(),
    losses: z.array(contentLossItemSchema),
    blocks: z.array(blockPositionSchema),
  }),
  z.object({
    verified: z.literal(false),
    blocks: z.array(blockPositionSchema),
    /** 다시 연 문서와 달라진 블록의 blocks 안 순서(누름틀은 같은 문단 안 순서로 id 가 갈려 위치 목록 전체가 필요하다) */
    different: z.array(z.number()),
    /** 다시 연 문서에만 있는 블록 수(지금 문서에 없어 id 를 댈 수 없다) */
    extraBlocks: z.number(),
    reopenError: z.string().optional(),
    losses: z.array(contentLossItemSchema),
  }),
]);
export type SaveExport = z.infer<typeof saveExportSchema>;

export interface SaveExportOptions {
  reopen?: Reopen;
  /** 이보다 큰 HWPX 는 서버로 보내지 않는다(기본 MAX_DOCUMENT_BYTES) */
  maxBytes?: number;
}

/** 저장용 내보내기: 내보내 다시 열어 비교하고, 같으면 바이트를 base64 로 싣는다. 크기 상한을 넘으면 던진다 */
export function exportForSave(doc: HwpDocument, options: SaveExportOptions = {}): SaveExport {
  const { reopen = reopenWithRhwp, maxBytes = MAX_DOCUMENT_BYTES } = options;
  const current = extractBlocks(doc);
  const exported = exportVerifiedHwpx(doc, current, reopen);
  const { bytes, losses, different, reopenError } = exported;
  if (bytes.length > maxBytes) throw new Error(tooLargeMessage(bytes.length, maxBytes));
  const blocks = current.map((block) => blockPositionSchema.parse(block));
  if (reopenError !== undefined) {
    // 다시 열지 못하면 모든 블록이 다르다고 보지만, 알릴 것은 이유다
    return { verified: false, blocks, different: [], extraBlocks: 0, reopenError, losses };
  }
  if (different.length > 0) {
    const inCurrent = different.filter((index) => index < current.length);
    return { verified: false, blocks, different: inCurrent, extraBlocks: different.length - inCurrent.length, losses };
  }
  return { verified: true, data: bytesToBase64(bytes), byteLength: bytes.length, losses, blocks };
}
