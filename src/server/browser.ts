// 기본 브라우저로 주소를 연다 (SPEC-004 "브라우저 열기"): 맥 open, 윈도우 cmd /c start "", 리눅스 xdg-open.
import { execFile } from 'node:child_process';
import { log } from './log.ts';

export interface BrowserCommand {
  command: string;
  args: string[];
  /** 윈도우: 인자를 따옴표로 다시 싸지 않고 그대로 붙인다(cmd 는 Node 의 따옴표 규칙을 모른다) */
  verbatim: boolean;
}

/** 실행기(execFile 모양). 테스트에서 바꿔 끼운다 */
export type CommandRunner = (
  command: string,
  args: string[],
  options: { windowsVerbatimArguments: boolean },
  done: (error: Error | null) => void,
) => void;

/**
 * cmd 의 특수 문자(& | < > ( ) ^)를 ^ 로 막는다 — 주소의 & 에서 명령이 끊기지 않게.
 * 따옴표로 싸면 그 안의 ^ 가 글자 그대로 남아 따옴표 없이 막는다.
 * % 는 막을 수 없지만 우리 주소(토큰 UUID·doc 이름 d1…)에는 %이름% 꼴이 생기지 않는다
 */
const escapeForCmd = (url: string) => url.replace(/[&|<>()^]/g, '^$&');

/** 플랫폼별 브라우저 열기 명령. start 의 첫 따옴표 인자는 창 제목이라 "" 를 둔다 */
export function browserCommand(url: string, platform: NodeJS.Platform): BrowserCommand {
  if (platform === 'darwin') return { command: 'open', args: [url], verbatim: false };
  if (platform === 'win32') return { command: 'cmd', args: ['/c', 'start', '""', escapeForCmd(url)], verbatim: true };
  return { command: 'xdg-open', args: [url], verbatim: false };
}

const runWithExecFile: CommandRunner = (command, args, options, done) => {
  execFile(command, args, options, (error) => done(error));
};

/** 열지 못하면 stderr 에 주소를 남긴다(Claude 는 결과의 viewerUrl 로 사용자에게 알린다) */
export function openInBrowser(url: string, platform: NodeJS.Platform = process.platform, run: CommandRunner = runWithExecFile): void {
  const { command, args, verbatim } = browserCommand(url, platform);
  run(command, args, { windowsVerbatimArguments: verbatim }, (error) => {
    if (error) log(`브라우저를 열지 못했습니다: ${error.message}. 직접 열어 주세요: ${url}`);
  });
}
