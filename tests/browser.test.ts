import { afterEach, describe, expect, it, vi } from 'vitest';
import { browserCommand, openInBrowser, type CommandRunner } from '../src/server/browser.ts';

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
