import { once } from 'node:events';
import { copyFile, mkdtemp, readFile, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { startBridge, type Bridge } from '../src/server/bridge.ts';
import { createMcpServer } from '../src/server/mcp.ts';
import { DocumentSession, MAX_FILE_BYTES, VIEWER_CONNECT_TIMEOUT_MS } from '../src/server/session.ts';
import { FakeViewer, paragraphBlocks } from './fake-viewer.ts';
import { fixturePath } from './fixtures.ts';

const toolResultSchema = z.object({
  content: z.array(z.object({ type: z.literal('text'), text: z.string() })),
  isError: z.boolean().optional(),
});
const openResultSchema = z.object({
  fileName: z.string(),
  pageCount: z.number(),
  blockCount: z.number(),
  viewerUrl: z.string(),
});

const NOT_CONNECTED = '뷰어가 연결되어 있지 않습니다. open_document 로 다시 여세요.';
const NO_DOCUMENT = '열린 문서가 없습니다. open_document 로 문서를 여세요.';

describe('SPEC-001 문서 열기 (open_document)', () => {
  let bridge: Bridge;
  let session: DocumentSession;
  let client: Client;
  let openBrowser: ReturnType<typeof vi.fn<(url: string) => void>>;
  const viewers: FakeViewer[] = [];

  const connectViewer = async () => {
    const viewer = await FakeViewer.connect(bridge.viewerUrl);
    viewers.push(viewer);
    return viewer;
  };

  const callOpen = async (path: string) =>
    toolResultSchema.parse(await client.callTool({ name: 'open_document', arguments: { path } }));

  /** 뷰어 하나가 다음 load_document 요청에 응답하게 하고 그 요청을 돌려준다 */
  const answerNextLoad = async (viewer: FakeViewer, pageCount: number, blockCount: number) => {
    const request = await viewer.nextRequest();
    viewer.respond(request.id, { pageCount, blocks: paragraphBlocks(blockCount) });
    return request;
  };

  const closeViewer = async (viewer: FakeViewer) => {
    const disconnected = once(bridge.events, 'disconnected');
    viewer.close();
    await disconnected;
  };

  beforeEach(async () => {
    bridge = await startBridge({ port: 0, viewerDir: tmpdir() });
    openBrowser = vi.fn<(url: string) => void>();
    session = new DocumentSession(bridge, { openBrowser });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await createMcpServer(session).connect(serverSide);
    client = new Client({ name: 'docbridge-test', version: '0.0.0' });
    await client.connect(clientSide);
  });

  afterEach(async () => {
    vi.useRealTimers();
    for (const viewer of viewers.splice(0)) viewer.close();
    await client.close();
    await bridge.close();
  });

  it.each([
    ['notice.hwpx', 'notice.hwpx'],
    ['notice.hwp', 'NOTICE.HWP'],
  ])('open_document 에 %s 경로를 주면(확장자 대소문자 무시) 뷰어가 문서를 렌더링하고 쪽 수·블록 수를 돌려준다', async (fixture, fileName) => {
    const dir = await mkdtemp(join(tmpdir(), 'docbridge-open-'));
    const path = join(dir, fileName);
    await copyFile(fixturePath(fixture), path);
    const viewer = await connectViewer();

    const [result, request] = await Promise.all([callOpen(path), answerNextLoad(viewer, 1, 14)]);

    expect(request.method).toBe('load_document');
    expect(request.params.fileName).toBe(fileName);
    expect(Buffer.from(request.params.data, 'base64')).toEqual(await readFile(fixturePath(fixture)));
    expect(result.isError).toBeUndefined();
    expect(openResultSchema.parse(JSON.parse(result.content[0]?.text ?? ''))).toEqual({
      fileName,
      pageCount: 1,
      blockCount: 14,
      viewerUrl: bridge.viewerUrl,
    });
  });

  it('연결된 뷰어가 없으면 기본 브라우저로 뷰어 주소를 열고, 그 탭이 붙으면 문서를 띄운다', async () => {
    openBrowser.mockImplementation((url) => {
      void FakeViewer.connect(url).then((viewer) => {
        viewers.push(viewer);
        void answerNextLoad(viewer, 1, 14);
      });
    });

    const result = await callOpen(fixturePath('notice.hwpx'));

    expect(openBrowser).toHaveBeenCalledExactlyOnceWith(bridge.viewerUrl);
    expect(openResultSchema.parse(JSON.parse(result.content[0]?.text ?? '')).pageCount).toBe(1);
  });

  it('이미 연결된 뷰어가 있으면 새 탭을 열지 않고 그 탭의 문서를 바꾼다', async () => {
    const viewer = await connectViewer();
    await Promise.all([callOpen(fixturePath('notice.hwpx')), answerNextLoad(viewer, 1, 14)]);

    const [second, request] = await Promise.all([callOpen(fixturePath('report.hwpx')), answerNextLoad(viewer, 2, 30)]);

    expect(openBrowser).not.toHaveBeenCalled();
    expect(request.params.fileName).toBe('report.hwpx');
    expect(openResultSchema.parse(JSON.parse(second.content[0]?.text ?? ''))).toMatchObject({
      fileName: 'report.hwpx',
      pageCount: 2,
      blockCount: 30,
    });
    expect(session.document?.fileName).toBe('report.hwpx');
  });

  it('확장자가 .hwp/.hwpx 가 아니면 파일을 읽지 않고 오류를 돌려준다', async () => {
    // 없는 파일이라 읽으려 했다면 "찾을 수 없습니다" 가 나온다
    const result = await callOpen('/없는/폴더/보고서.docx');

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe('열 수 없는 파일 형식입니다(.docx). .hwp, .hwpx 만 열 수 있습니다.');
    expect(openBrowser).not.toHaveBeenCalled();
  });

  it('없는 파일이면 경로와 함께 찾을 수 없다고 알린다', async () => {
    const result = await callOpen('/없는/폴더/공문.hwpx');

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe('파일을 찾을 수 없습니다: /없는/폴더/공문.hwpx');
  });

  it('50MB 를 넘는 파일은 읽지 않고 오류를 돌려준다', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'docbridge-big-')), '큰문서.hwpx');
    await writeFile(path, '');
    await truncate(path, MAX_FILE_BYTES + 1);

    const result = await callOpen(path);

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe('파일이 너무 큽니다(51MB). 50MB 까지 열 수 있습니다.');
    expect(openBrowser).not.toHaveBeenCalled();
  });

  it('rhwp 가 읽지 못하는 파일이면 뷰어가 알려준 이유를 돌려준다', async () => {
    const viewer = await connectViewer();
    const opening = callOpen(fixturePath('notice.hwpx'));
    const request = await viewer.nextRequest();
    viewer.fail(request.id, 'HWPX 압축을 풀 수 없습니다');

    const result = await opening;

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe('문서를 열 수 없습니다: HWPX 압축을 풀 수 없습니다');
  });

  it('브라우저를 띄웠는데 정해진 시간 안에 뷰어가 붙지 않으면 뷰어 주소와 함께 오류를 돌려준다', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const browserOpened = new Promise<void>((resolve) => openBrowser.mockImplementation(() => resolve()));
    const opening = session.open(fixturePath('notice.hwpx'));
    const failed = expect(opening).rejects.toThrow(
      `뷰어가 ${VIEWER_CONNECT_TIMEOUT_MS / 1000}초 안에 연결되지 않았습니다. 브라우저에서 ${bridge.viewerUrl} 을 열고 다시 시도하세요.`,
    );

    await browserOpened;
    vi.advanceTimersByTime(VIEWER_CONNECT_TIMEOUT_MS);

    await failed;
  });

  it('뷰어가 연결되어 있지 않을 때 문서가 필요한 도구는 정해진 오류 문구와 마지막 파일 경로를 돌려준다', async () => {
    const path = fixturePath('notice.hwpx');
    const viewer = await connectViewer();
    await Promise.all([session.open(path), answerNextLoad(viewer, 1, 14)]);
    await closeViewer(viewer);

    await expect(session.requestViewer('load_document', { fileName: 'x.hwpx', data: '' })).rejects.toThrow(
      `${NOT_CONNECTED} 마지막 파일: ${path}`,
    );
  });

  it('문서를 연 적이 없고 뷰어도 없으면 정해진 오류 문구만 돌려준다', async () => {
    await expect(session.requestViewer('load_document', { fileName: 'x.hwpx', data: '' })).rejects.toThrow(
      new RegExp(`^${NOT_CONNECTED.replace('.', '\\.')}$`),
    );
  });

  it('요청 중에 뷰어 연결이 끊기면 같은 오류 문구와 마지막 파일 경로를 돌려준다', async () => {
    const path = fixturePath('notice.hwpx');
    const viewer = await connectViewer();
    await Promise.all([session.open(path), answerNextLoad(viewer, 1, 14)]);

    const pending = session.requestViewer('load_document', { fileName: 'x.hwpx', data: '' });
    await viewer.nextRequest();
    viewer.close();

    await expect(pending).rejects.toThrow(`${NOT_CONNECTED} 마지막 파일: ${path}`);
  });

  it('뷰어 탭을 새로고침해도 같은 문서가 다시 뜨고 블록 id 가 그대로다', async () => {
    const path = fixturePath('notice.hwpx');
    const first = await connectViewer();
    await Promise.all([session.open(path), answerNextLoad(first, 1, 14)]);
    const idsBefore = session.document?.ids;
    const labelsBefore = idsBefore?.label(paragraphBlocks(14)).map(({ id }) => id);

    // 새로고침 = 이전 연결이 끊기고 같은 주소로 새 연결이 붙는다
    await closeViewer(first);
    const reloaded = await connectViewer();
    const request = await answerNextLoad(reloaded, 1, 14);
    await session.ready();

    expect(request.params.fileName).toBe('notice.hwpx');
    expect(Buffer.from(request.params.data, 'base64')).toEqual(await readFile(path));
    expect(openBrowser).not.toHaveBeenCalled();
    expect(session.document?.ids).toBe(idsBefore);
    expect(session.document?.ids.label(paragraphBlocks(14)).map(({ id }) => id)).toEqual(labelsBefore);
  });

  it('새로고침으로 이전 문서를 다시 띄우는 중에 다른 파일을 열면 뷰어에 마지막으로 남는 문서가 서버의 현재 문서다', async () => {
    // 새로고침 쪽 파일 읽기를 붙잡아 두고, 새 파일 읽기가 끝난 다음 차례에 놓아준다
    let holdReload = false;
    let releaseReload = () => {};
    let reloadReadStarted = () => {};
    const reloadReading = new Promise<void>((resolve) => {
      reloadReadStarted = resolve;
    });
    const raced = new DocumentSession(bridge, {
      openBrowser,
      readFile: async (path) => {
        if (holdReload && path.endsWith('notice.hwpx')) {
          const released = new Promise<void>((resolve) => {
            releaseReload = resolve;
          });
          reloadReadStarted();
          await released;
        }
        if (path.endsWith('report.hwpx')) setImmediate(() => releaseReload());
        return readFile(path);
      },
    });
    const first = await connectViewer();
    first.autoRespond({ pageCount: 1, blocks: paragraphBlocks(14) });
    await raced.open(fixturePath('notice.hwpx'));

    holdReload = true;
    await closeViewer(first);
    const reloaded = await connectViewer();
    reloaded.autoRespond({ pageCount: 1, blocks: paragraphBlocks(14) });
    await reloadReading;
    await raced.open(fixturePath('report.hwpx'));
    await raced.ready();

    expect(raced.document?.fileName).toBe('report.hwpx');
    expect(reloaded.history.at(-1)?.params.fileName).toBe('report.hwpx');
  });

  it('새 파일을 rhwp 가 읽지 못하면 서버도 열린 문서를 비우고, 새로고침해도 이전 문서를 되살리지 않는다', async () => {
    const viewer = await connectViewer();
    await Promise.all([session.open(fixturePath('notice.hwpx')), answerNextLoad(viewer, 1, 14)]);

    const opening = session.open(fixturePath('report.hwpx'));
    const request = await viewer.nextRequest();
    viewer.fail(request.id, '손상된 파일입니다');
    await expect(opening).rejects.toThrow('문서를 열 수 없습니다: 손상된 파일입니다');

    expect(session.document).toBeUndefined();
    await expect(session.requestViewer('load_document', { fileName: 'x.hwpx', data: '' })).rejects.toThrow(NO_DOCUMENT);

    await closeViewer(viewer);
    const reloaded = await connectViewer();
    reloaded.autoRespond({ pageCount: 1, blocks: paragraphBlocks(14) });
    await session.ready();
    expect(reloaded.history).toEqual([]);
  });

  it('새로고침 때 파일이 바뀌어 블록 위치가 달라졌으면 블록 id 를 새로 붙인다', async () => {
    const first = await connectViewer();
    await Promise.all([session.open(fixturePath('notice.hwpx')), answerNextLoad(first, 1, 14)]);
    const idsBefore = session.document?.ids;

    await closeViewer(first);
    const reloaded = await connectViewer();
    reloaded.autoRespond({ pageCount: 1, blocks: paragraphBlocks(15) });
    await session.ready();

    expect(session.document?.ids).not.toBe(idsBefore);
    expect(session.document?.blockCount).toBe(15);
    expect(session.document?.ids.label(paragraphBlocks(15)).map(({ id }) => id).at(-1)).toBe('b15');
  });

  it('새로고침 때 파일이 사라졌으면 열린 문서를 비우고 뷰어에 보내지 않는다', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'docbridge-gone-')), '공문.hwpx');
    await copyFile(fixturePath('notice.hwpx'), path);
    const first = await connectViewer();
    await Promise.all([session.open(path), answerNextLoad(first, 1, 14)]);

    await closeViewer(first);
    await rm(path);
    const reloaded = await connectViewer();
    reloaded.autoRespond({ pageCount: 1, blocks: paragraphBlocks(14) });
    await session.ready();

    expect(session.document).toBeUndefined();
    expect(reloaded.history).toEqual([]);
  });
});
