// Node(테스트·스크립트)에서 @rhwp/core 를 쓰기 위한 초기화.
// 브라우저 뷰어는 Canvas 로 글자 폭을 재지만, Node 에는 Canvas 가 없어서
// 글자 수 × 글자 크기로 근사한다. 그래서 Node 에서는 줄바꿈·쪽 나눔이 브라우저와 다를 수 있다.
// 문단·표·누름틀 구조와 번호 문자열은 글자 폭과 무관하므로 테스트에 쓸 수 있다.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { HwpDocument, initSync } from '@rhwp/core';

let initialized = false;

function approximateTextWidth(font: string, text: string): number {
  const size = /(\d+(?:\.\d+)?)px/.exec(font)?.[1];
  const fontSize = size === undefined ? 12 : Number(size);
  return [...text].length * fontSize * 0.9;
}

export function initRhwpForNode(): void {
  if (initialized) return;
  Object.assign(globalThis, { measureTextWidth: approximateTextWidth });
  const wasmPath = fileURLToPath(import.meta.resolve('@rhwp/core/rhwp_bg.wasm'));
  initSync({ module: readFileSync(wasmPath) });
  initialized = true;
}

export function openDocumentFile(path: string): HwpDocument {
  initRhwpForNode();
  return new HwpDocument(new Uint8Array(readFileSync(path)));
}

export function createBlankDocument(): HwpDocument {
  initRhwpForNode();
  const doc = HwpDocument.createEmpty();
  doc.createBlankDocument();
  return doc;
}
