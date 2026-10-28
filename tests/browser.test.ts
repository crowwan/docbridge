import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startBridge } from '../src/server/bridge.ts';
import { browserCommand, openInBrowser, type CommandRunner } from '../src/server/browser.ts';
import { documentName } from '../src/server/documents.ts';

const URL_WITH_DOC = 'http://127.0.0.1:7790/?token=abc-123&doc=d2';

describe('SPEC-004 브라우저 열기 (플랫폼별 명령)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('맥에서는 open <주소> 를 쓴다', () => {
    expect(browserCommand(URL_WITH_DOC, 'darwin')).toEqual({ command: 'open', args: [URL_WITH_DOC], verbatim: false });
  });

  it('리눅스(와 그 밖의 유닉스)에서는 xdg-open <주소> 를 쓴다', () => {
    expect(browserCommand(URL_WITH_DOC, 'linux')).toEqual({ command: 'xdg-open', args: [URL_WITH_DOC], verbatim: false });
    expect(browserCommand(URL_WITH_DOC, 'freebsd').command).toBe('xdg-open');
  });

  it('윈도우에서는 cmd /c start "" <주소> 를 쓰고, 주소의 & 가 cmd 에서 명령을 끊지 않게 ^& 로 바꿔 그대로 넘긴다', () => {
    expect(browserCommand(URL_WITH_DOC, 'win32')).toEqual({
      command: 'cmd',
      args: ['/c', 'start', '""', 'http://127.0.0.1:7790/?token=abc-123^&doc=d2'],
      // 인자를 따옴표로 다시 싸면 cmd 가 "" 를 창 제목으로 못 읽고, 따옴표 안의 ^ 는 글자 그대로 남는다
      verbatim: true,
    });
  });

  it('윈도우에서 cmd 특수 문자(^ | < > ( ))도 모두 ^ 로 막는다', () => {
    expect(browserCommand('http://h/?a=(1)|<2>^', 'win32').args[3]).toBe('http://h/?a=^(1^)^|^<2^>^^');
  });

  it('브라우저로 여는 실제 주소(토큰 UUID, 문서 이름 d1, d2 …)에는 % 가 없다 — cmd 는 %이름% 을 환경 변수로 펼치고 ^ 로 막을 수 없다', async () => {
    // PR #96 리뷰: 문서 이름이 바뀌어 퍼센트 인코딩이 생기면 윈도우에서 주소가 바뀐다. 그 전제를 여기서 고정한다
    const bridge = await startBridge({ port: 0, viewerDir: tmpdir() });
    try {
      // 닫고 다시 열면 번호가 계속 올라가므로 상한보다 넉넉히 본다
      const urls = [bridge.viewerUrl, ...Array.from({ length: 100 }, (_, i) => bridge.viewerUrlFor(documentName(i + 1)))];
      expect(urls.filter((url) => url.includes('%'))).toEqual([]);
      expect(bridge.viewerUrlFor(documentName(2))).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?token=[0-9a-f-]{36}&doc=d2$/);
    } finally {
      await bridge.close();
    }
  });

  it('고른 명령을 실행기에 넘긴다(윈도우는 인자를 그대로 붙이는 옵션과 함께)', () => {
    const run = vi.fn<CommandRunner>();

    openInBrowser(URL_WITH_DOC, 'win32', run);

    expect(run).toHaveBeenCalledWith(
      'cmd',
      ['/c', 'start', '""', 'http://127.0.0.1:7790/?token=abc-123^&doc=d2'],
      { windowsVerbatimArguments: true },
      expect.any(Function),
    );
  });

  it('열지 못하면 stderr 에 이유와 주소를 남긴다(주소는 바꾸지 않은 원래 주소)', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const run: CommandRunner = (_command, _args, _options, done) => done(new Error('spawn xdg-open ENOENT'));

    openInBrowser(URL_WITH_DOC, 'linux', run);

    expect(stderr).toHaveBeenCalledWith(
      `[docbridge] 브라우저를 열지 못했습니다: spawn xdg-open ENOENT. 직접 열어 주세요: ${URL_WITH_DOC}\n`,
    );
  });

  it('열었으면 아무것도 남기지 않는다', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const run: CommandRunner = (_command, _args, _options, done) => done(null);

    openInBrowser(URL_WITH_DOC, 'darwin', run);

    expect(stderr).not.toHaveBeenCalled();
  });
});
