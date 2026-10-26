// 기본 브라우저로 주소를 연다 (macOS `open`).
import { execFile } from 'node:child_process';
import { log } from './log.ts';

export function openInBrowser(url: string): void {
  execFile('open', [url], (error) => {
    if (error) log(`브라우저를 열지 못했습니다: ${error.message}. 직접 열어 주세요: ${url}`);
  });
}
