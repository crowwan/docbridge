import { once } from 'node:events';
import { chmod, copyFile, mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HwpDocument } from '@rhwp/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { extractBlocks } from '../src/core/blocks.ts';
import { insertParagraphNear } from '../src/core/edits.ts';
import { startBridge, type Bridge } from '../src/server/bridge.ts';
import { createMcpServer } from '../src/server/mcp.ts';
import { writeSave } from '../src/server/save-path.ts';
import { decodeExport, saveDocument } from '../src/server/save-tool.ts';
import { DocumentSession, type OpenedDocument } from '../src/server/session.ts';
import { tooLargeMessage } from '../src/shared/limits.ts';
import { FakeViewer } from './fake-viewer.ts';
import { fixturePath } from './fixtures.ts';
import { rhwpViewer, type RhwpViewer, type RhwpViewerOptions } from './rhwp-viewer.ts';

const toolResultSchema = z.object({
  content: z.array(z.object({ type: z.literal('text'), text: z.string() })),
  isError: z.boolean().optional(),
});
const saveResultSchema = z.object({
  path: z.string(),
  bytes: z.number(),
  verified: z.object({ blockCount: z.number() }),
  warnings: z.array(z.string()).optional(),
});
const outlineSchema = z.object({ blocks: z.array(z.object({ id: z.string(), text: z.string() })) });

const NOT_CONNECTED = '뷰어가 연결되어 있지 않습니다. open_document 로 다시 여세요.';
const VERIFY_FAILED = '저장 전 검증에 실패해 파일을 쓰지 않았습니다.';

// 두 묶음이 같이 쓰는 준비: 브리지·세션·MCP 클라이언트, 임시 폴더, rhwp 테스트 뷰어
let bridge: Bridge;
let session: DocumentSession;
let client: Client;
let dir: string;
const sockets: FakeViewer[] = [];

const call = async (name: string, args: Record<string, unknown> = {}) =>
  toolResultSchema.parse(await client.callTool({ name, arguments: args }));
const save = async (args: Record<string, unknown> = {}) => {
  const result = await call('save_document', args);
  if (result.isError) throw new Error(result.content[0]?.text);
  return saveResultSchema.parse(JSON.parse(result.content[0]?.text ?? ''));
};
const saveError = async (args: Record<string, unknown> = {}) => {
  const result = await call('save_document', args);
  expect(result.isError).toBe(true);
  return result.content[0]?.text;
};
const outline = async () => {
  const result = await call('get_outline');
  return { blocks: outlineSchema.parse(JSON.parse(result.content[0]?.text ?? '')).blocks, notices: result.content.slice(1).map((c) => c.text) };
};

/** rhwp 테스트 뷰어를 붙인다 */
const connectRhwp = async (options: RhwpViewerOptions = {}): Promise<RhwpViewer> => {
  const socket = await FakeViewer.connect(bridge.viewerUrl);
  sockets.push(socket);
  const viewer = rhwpViewer(options);
  socket.serve(viewer.handle);
  return viewer;
};

/** 임시 폴더에 fixture 를 복사해 연다 */
const openCopy = async (fixture: string, name: string) => {
  const path = join(dir, name);
  await copyFile(fixturePath(fixture), path);
  await session.open(path);
  return path;
};

const opened = (): OpenedDocument => {
  const document = session.document;
  if (document === undefined) throw new Error('열린 문서가 없습니다');
  return document;
};

/**
 * 편집 하나(#19 편집 도구가 할 일을 테스트가 직접): 뷰어 문서에서 글자 있는 첫 문단(구역 첫 문단 제외) 뒤에 문단을 넣고,
 * 서버 id 표를 옮기고 편집 기록에 남긴다. 새 블록 id 를 돌려준다
 */
const insertParagraph = (viewer: RhwpViewer, text: string): string => {
  const doc = viewer.doc();
  const reference = extractBlocks(doc).find((b) => b.kind === 'paragraph' && b.paragraph > 0 && b.text.length > 0);
  if (reference === undefined) throw new Error('기준 문단이 없습니다');
  const at = insertParagraphNear(doc, reference.section, reference.paragraph, 'after', text);
  viewer.edited();
  const document = opened();
  const before = document.ids.clone();
  const id = document.ids.paragraphInserted(reference.section, at);
  document.edits.record('insert_paragraph', before);
  return id;
};

/** 뷰어 탭 새로고침: 연결이 끊기고 같은 주소로 새 (빈) 뷰어가 붙는다 */
const refresh = async (): Promise<RhwpViewer> => {
  const disconnected = once(bridge.events, 'disconnected');
  sockets.at(-1)?.close();
  await disconnected;
  const viewer = await connectRhwp();
  await session.ready();
  return viewer;
};

const blockTexts = (bytes: Uint8Array) => {
  const doc = new HwpDocument(bytes);
  try {
    return extractBlocks(doc).map((b) => (b.kind === 'paragraph' ? b.text : b.kind));
  } finally {
    doc.free();
  }
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'docbridge-save-'));
  bridge = await startBridge({ port: 0, viewerDir: tmpdir() });
  session = new DocumentSession(bridge, { openBrowser: () => {} });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createMcpServer(session).connect(serverSide);
  client = new Client({ name: 'docbridge-test', version: '0.0.0' });
  await client.connect(clientSide);
});

afterEach(async () => {
  await chmod(dir, 0o755);
  for (const socket of sockets.splice(0)) socket.close();
  await client.close();
  await bridge.close();
});

describe('SPEC-002 저장 (save_document)', () => {
  it('경로가 없으면 원본 옆 <이름>-수정.hwpx 로 저장하고 경로·크기·검증 결과를 돌려준다', async () => {
    // AC-9
    const viewer = await connectRhwp();
    await openCopy('notice.hwp', '공문.hwp');
    insertParagraph(viewer, '새로 넣은 문단');

    const result = await save();

    const expected = join(dir, '공문-수정.hwpx');
    const written = new Uint8Array(await readFile(expected));
    expect(result).toEqual({ path: expected, bytes: written.length, verified: { blockCount: 15 } });
    expect(blockTexts(written)).toContain('새로 넣은 문단');
    expect(await readdir(dir)).toEqual(['공문-수정.hwpx', '공문.hwp']);
  });

  it('기본 이름이 겹치면 -수정-2 로, 원본·기존 파일은 overwrite: true 일 때만 덮어쓴다', async () => {
    // AC-9
    const viewer = await connectRhwp();
    const source = await openCopy('notice.hwpx', '공문.hwpx');
    insertParagraph(viewer, '첫 편집');

    expect((await save()).path).toBe(join(dir, '공문-수정.hwpx'));
    expect((await save()).path).toBe(join(dir, '공문-수정-2.hwpx'));
    expect(await saveError({ path: '공문-수정.hwpx' })).toBe(
      `이미 있는 파일입니다: ${join(dir, '공문-수정.hwpx')}. 덮어쓰려면 overwrite: true 를 주세요.`,
    );
    expect(await saveError({ path: source })).toBe(`원본 파일입니다: ${source}. 덮어쓰려면 overwrite: true 를 주세요.`);

    expect((await save({ path: source, overwrite: true })).path).toBe(source);
    expect(blockTexts(new Uint8Array(await readFile(source)))).toContain('첫 편집');
  });

  it('경로 없이 동시에 두 번 저장하면 서로 덮지 않고 -수정·-수정-2 두 파일이 생긴다', async () => {
    // AC-9 — 둘 다 경로를 정할 때는 -수정.hwpx 가 비어 있다
    const viewer = await connectRhwp();
    await openCopy('notice.hwpx', '공문.hwpx');
    insertParagraph(viewer, '새로 넣은 문단');

    const results = await Promise.all([save(), save()]);

    expect(results.map((r) => r.path).toSorted()).toEqual([join(dir, '공문-수정-2.hwpx'), join(dir, '공문-수정.hwpx')]);
    expect((await readdir(dir)).toSorted()).toEqual(['공문-수정-2.hwpx', '공문-수정.hwpx', '공문.hwpx']);
  });

  it('원본이 .hwp 면 overwrite: true 여도 원본을 덮어쓰지 않는다', async () => {
    // AC-9
    await connectRhwp();
    const source = await openCopy('notice.hwp', '공문.hwp');

    expect(await saveError({ path: source, overwrite: true })).toBe(
      '원본(.hwp)은 덮어쓸 수 없습니다. 저장은 항상 HWPX 입니다. path 를 빼면 공문-수정.hwpx 로 저장합니다.',
    );
    expect(await readFile(source)).toEqual(await readFile(fixturePath('notice.hwp')));
  });

  it('다시 연 문서의 블록 글자가 다르면 파일을 쓰지 않고 달라진 블록 id 를 돌려준다', async () => {
    // AC-10 — 내보내기가 편집을 잃은 것처럼 원래 파일 바이트를 다시 연다
    const unedited = new Uint8Array(await readFile(fixturePath('notice.hwpx')));
    const viewer = await connectRhwp({ reopen: () => new HwpDocument(unedited) });
    const source = await openCopy('notice.hwpx', '공문.hwpx');
    const inserted = insertParagraph(viewer, '새로 넣은 문단');

    const error = await saveError();

    // 넣은 문단부터 뒤 블록들의 글자가 한 칸씩 어긋나고, 다시 연 문서는 블록이 하나 적다
    expect(error).toMatch(new RegExp(`^${VERIFY_FAILED.replace('.', '\\.')} 다시 연 문서와 다른 블록: ${inserted}, b\\d+`));
    expect(await readdir(dir)).toEqual(['공문.hwpx']);
    expect(session.unsavedEdits).toBe(1);
    expect(opened().path).toBe(source);
  });

  it('내보낸 HWPX 를 다시 열지 못하면 파일을 쓰지 않고 그 이유를 돌려준다', async () => {
    // AC-10
    await connectRhwp({
      reopen: () => {
        throw new Error('압축을 풀 수 없습니다');
      },
    });
    await openCopy('notice.hwpx', '공문.hwpx');

    expect(await saveError()).toBe(`${VERIFY_FAILED} 내보낸 HWPX 를 다시 열지 못했습니다: 압축을 풀 수 없습니다`);
    expect(await readdir(dir)).toEqual(['공문.hwpx']);
  });

  it('내보내기 보고서에 손실 항목이 있으면 저장하고 결과에 경고로 담는다', async () => {
    const socket = await FakeViewer.connect(bridge.viewerUrl);
    sockets.push(socket);
    const real = rhwpViewer();
    socket.serve((request) => {
      if (request.method !== 'export_hwpx') return real.handle(request);
      const result = real.handle(request);
      if (typeof result !== 'object' || result === null) throw new Error('결과가 없습니다');
      return { ...result, losses: [{ code: 'binaryContentEmptied', subject: '그림', path: 'BinData/image1.png', reason: 'resourceReadFailedOrLimitExceeded' }] };
    });
    await openCopy('notice.hwpx', '공문.hwpx');

    const result = await save();

    expect(result.warnings).toEqual([
      'HWPX 로 내보내며 빠지거나 줄어든 내용이 있습니다: 그림(binaryContentEmptied, resourceReadFailedOrLimitExceeded) — BinData/image1.png',
    ]);
    expect(await readdir(dir)).toContain('공문-수정.hwpx');
  });

  it('저장한 파일을 다시 open_document 하면 편집한 내용이 그대로 보인다', async () => {
    // AC-11
    const viewer = await connectRhwp();
    await openCopy('notice.hwpx', '공문.hwpx');
    insertParagraph(viewer, '저장해 둔 문단');
    const { path } = await save();

    await session.open(path);

    expect((await outline()).blocks.map((b) => b.text)).toContain('저장해 둔 문단');
  });

  it('저장하면 저장 경로가 마지막 파일이 되고 저장하지 않은 편집 수가 0 이 되며 뷰어에 알린다', async () => {
    const viewer = await connectRhwp();
    await openCopy('notice.hwpx', '공문.hwpx');
    insertParagraph(viewer, '새로 넣은 문단');

    const { path } = await save();

    expect(session.unsavedEdits).toBe(0);
    expect(viewer.editStates).toEqual([{ fileName: '공문-수정.hwpx', unsavedEdits: 0 }]);
    const disconnected = once(bridge.events, 'disconnected');
    sockets.at(-1)?.close();
    await disconnected;
    expect((await call('get_outline')).content[0]?.text).toBe(`${NOT_CONNECTED} 마지막 파일: ${path}`);
  });

  it('뷰어의 저장하지 않은 편집 수는 서버 편집 기록 값을 따른다(저장 뒤 되돌리면 다시 1)', async () => {
    const viewer = await connectRhwp();
    await openCopy('notice.hwpx', '공문.hwpx');
    insertParagraph(viewer, '새로 넣은 문단');
    await save();

    // 저장한 편집을 되돌리면 저장한 파일과 다시 달라진다(#19 undo 가 할 일)
    opened().edits.undo(1);
    await session.syncViewerEditState();

    expect(viewer.editStates).toEqual([
      { fileName: '공문-수정.hwpx', unsavedEdits: 0 },
      { fileName: '공문-수정.hwpx', unsavedEdits: 1 },
    ]);
  });

  it('파일을 쓰는 사이 다른 문서를 열면 파일은 쓰되 새 문서의 마지막 파일·뷰어 상태는 바꾸지 않는다', async () => {
    const viewer = await connectRhwp();
    await openCopy('notice.hwpx', '공문.hwpx');
    insertParagraph(viewer, '새로 넣은 문단');
    const other = join(dir, '보고서.hwpx');
    await copyFile(fixturePath('report.hwpx'), other);

    const result = await saveDocument(session, {}, async (target, bytes) => {
      await session.open(other);
      return writeSave(target, bytes);
    });

    expect(result.path).toBe(join(dir, '공문-수정.hwpx'));
    expect(result.warnings).toEqual(['저장하는 사이 다른 문서(보고서.hwpx)를 열어, 열린 문서의 마지막 파일은 바꾸지 않았습니다.']);
    expect(opened().path).toBe(other);
    expect(viewer.editStates).toEqual([]);
  });

  it('파일을 쓰지 못하면 이유를 돌려주고 마지막 파일과 저장하지 않은 편집 수를 그대로 둔다', async () => {
    const viewer = await connectRhwp();
    const source = await openCopy('notice.hwpx', '공문.hwpx');
    insertParagraph(viewer, '새로 넣은 문단');
    await chmod(dir, 0o555);

    expect(await saveError()).toMatch(/^저장하지 못했습니다: .*EACCES/);

    expect(opened().path).toBe(source);
    expect(session.unsavedEdits).toBe(1);
    expect(viewer.editStates).toEqual([]);
  });

  it('뷰어가 보낸 파일이 크기 상한을 넘거나 길이가 맞지 않으면 쓰지 않는다', () => {
    const data = Buffer.from(new Uint8Array(2048)).toString('base64');

    expect(() => decodeExport(data, 2048, 1024)).toThrow(/^저장할 문서가 너무 큽니다/);
    // 상한과 같은 크기는 받고, 한 바이트라도 넘으면 풀기 전에 거른다
    expect(decodeExport(data, 2048, 2048)).toHaveLength(2048);
    expect(() => decodeExport(Buffer.from(new Uint8Array(2049)).toString('base64'), 2049, 2048)).toThrow(/^저장할 문서가 너무 큽니다/);
    expect(() => decodeExport(data, 2048, 3 * 1024 * 1024 - 1)).not.toThrow();
    expect(tooLargeMessage(51 * 1024 * 1024 + 1, 50 * 1024 * 1024)).toBe('저장할 문서가 너무 큽니다(52MB). 50MB 까지 저장할 수 있습니다.');
    expect(() => decodeExport(data, 4096)).toThrow('뷰어가 보낸 파일이 온전하지 않습니다(4096바이트 중 2048바이트). 다시 저장하세요.');
  });

  it('뷰어가 없으면 미연결 오류를 돌려준다', async () => {
    expect(await saveError()).toBe(NOT_CONNECTED);
  });
});

describe('SPEC-002 새로고침과 저장하지 않은 편집', () => {
  it('새로고침하면 마지막으로 저장한 파일 상태로 돌아가 블록 id 가 그때와 같고, 다음 도구 결과에 사라진 편집 수를 알린다', async () => {
    // AC-14
    const viewer = await connectRhwp();
    const source = join(dir, '공문.hwpx');
    await copyFile(fixturePath('notice.hwpx'), source);
    await session.open(source);
    const saved = insertParagraph(viewer, '저장한 문단');
    const save = toolResultSchema.parse(await client.callTool({ name: 'save_document', arguments: {} }));
    expect(save.isError).toBeUndefined();
    const atSave = await outline();
    insertParagraph(viewer, '저장 안 한 문단');
    insertParagraph(viewer, '저장 안 한 문단 2');

    await refresh();

    const after = await outline();
    expect(opened().path).toBe(join(dir, '공문-수정.hwpx'));
    expect(after.blocks).toEqual(atSave.blocks);
    expect(after.blocks.map((b) => b.id)).toContain(saved);
    expect(after.notices).toEqual(['뷰어를 새로고침해서 저장하지 않은 편집 2개가 사라졌습니다.']);
    expect(session.unsavedEdits).toBe(0);
    expect(session.editCount).toBe(0);
    // 알림은 한 번만
    expect((await outline()).notices).toEqual([]);
  });

  it('저장한 적이 없으면 새로고침 때 연 파일 상태와 그때의 블록 id 로 돌아간다', async () => {
    // AC-14
    const viewer = await connectRhwp();
    const source = join(dir, '공문.hwpx');
    await copyFile(fixturePath('notice.hwpx'), source);
    await session.open(source);
    const atOpen = await outline();
    const inserted = insertParagraph(viewer, '저장 안 한 문단');

    await refresh();

    const after = await outline();
    expect(after.blocks).toEqual(atOpen.blocks);
    expect(after.blocks.map((b) => b.id)).not.toContain(inserted);
    expect(after.notices).toEqual(['뷰어를 새로고침해서 저장하지 않은 편집 1개가 사라졌습니다.']);
  });

  it('새로고침한 탭이 다시 띄우기 전에 끊겨도 사라진 편집 알림은 한 번만 붙는다', async () => {
    const viewer = await connectRhwp();
    const source = join(dir, '공문.hwpx');
    await copyFile(fixturePath('notice.hwpx'), source);
    await session.open(source);
    insertParagraph(viewer, '저장 안 한 문단');

    // 첫 새로고침: 새 탭이 문서를 받기 전에 닫힌다
    const disconnected = once(bridge.events, 'disconnected');
    sockets.at(-1)?.close();
    await disconnected;
    const flaky = await FakeViewer.connect(bridge.viewerUrl);
    await flaky.nextRequest();
    const flakyGone = once(bridge.events, 'disconnected');
    flaky.close();
    await flakyGone;
    await session.ready();
    // 두 번째 새로고침은 제대로 붙는다
    await connectRhwp();
    await session.ready();

    expect((await outline()).notices).toEqual(['뷰어를 새로고침해서 저장하지 않은 편집 1개가 사라졌습니다.']);
  });

  it('저장한 뒤 편집이 없으면 새로고침해도 알림이 없다', async () => {
    const viewer = await connectRhwp();
    const source = join(dir, '공문.hwpx');
    await copyFile(fixturePath('notice.hwpx'), source);
    await session.open(source);
    insertParagraph(viewer, '저장한 문단');
    await client.callTool({ name: 'save_document', arguments: {} });

    await refresh();

    expect((await outline()).notices).toEqual([]);
  });
});
