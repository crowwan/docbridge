// Node(테스트·스크립트)에서 @rhwp/core 를 쓰기 위한 초기화.
// 브라우저 뷰어는 Canvas 로 글자 폭을 재지만, Node 에는 Canvas 가 없어서
// 글자 수 × 글자 크기로 근사한다. 그래서 Node 에서는 줄바꿈·쪽 나눔이 브라우저와 다를 수 있다.
// 문단·표·누름틀 구조와 번호 문자열은 글자 폭과 무관하므로 테스트에 쓸 수 있다.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { HwpDocument, initSync, type InitOutput } from '@rhwp/core';
import { blankDocument } from './create-document.ts';

let wasm: InitOutput | undefined;

function approximateTextWidth(font: string, text: string): number {
  const size = /(\d+(?:\.\d+)?)px/.exec(font)?.[1];
  const fontSize = size === undefined ? 12 : Number(size);
  return [...text].length * fontSize * 0.9;
}

export function initRhwpForNode(): void {
  if (wasm !== undefined) return;
  Object.assign(globalThis, { measureTextWidth: approximateTextWidth });
  const wasmPath = fileURLToPath(import.meta.resolve('@rhwp/core/rhwp_bg.wasm'));
  wasm = initSync({ module: readFileSync(wasmPath) });
}

/** WASM 선형 메모리 크기(바이트). 늘기만 하고 줄지 않는다 — 스냅샷 메모리 측정용(scripts/measure-edits.ts) */
export function wasmMemoryBytes(): number {
  initRhwpForNode();
  return wasm?.memory.buffer.byteLength ?? 0;
}

export function openDocumentFile(path: string): HwpDocument {
  initRhwpForNode();
  return new HwpDocument(new Uint8Array(readFileSync(path)));
}

export function createBlankDocument(): HwpDocument {
  initRhwpForNode();
  return blankDocument();
}
