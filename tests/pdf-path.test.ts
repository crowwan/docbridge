// SPEC-008 AC-5: export_pdf 경로 규칙(기본 이름·겹침·상대 경로·확장자·덮어쓰기·원본 확장자 거부)이 save_document 와 같다.
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { nextPdfName, resolvePdfPath, writeSave } from '../src/server/save-path.ts';

describe('SPEC-008 PDF 경로 정하기 (export_pdf 경로 규칙)', () => {
  let dir: string;
  let home: string;
  let document: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'docbridge-pdf-path-'));
    home = await mkdtemp(join(tmpdir(), 'docbridge-home-'));
    document = join(dir, '공문.hwpx');
    await writeFile(document, 'hwpx');
  });

  const resolve = (path: string | undefined, overwrite = false) =>
    resolvePdfPath({ documentPath: document, baseDir: dir, ...(path === undefined ? {} : { path }), overwrite }, home);

  it('경로가 없으면 문서 옆 <이름>.pdf', async () => {
    expect(await resolve(undefined)).toBe(join(dir, '공문.pdf'));
  });

  it('기본 이름이 이미 있으면 <이름>-2.pdf, -3 … 중 처음 비어 있는 것(경로가 없으면 overwrite 는 쓰이지 않는다)', async () => {
    await writeFile(join(dir, '공문.pdf'), '');
    await writeFile(join(dir, '공문-2.pdf'), '');

    expect(await resolve(undefined)).toBe(join(dir, '공문-3.pdf'));
    expect(await resolve(undefined, true)).toBe(join(dir, '공문-3.pdf'));
  });

  it('상대 경로는 기준 폴더(원본 폴더), ~/ 는 홈 폴더 기준', async () => {
    await mkdir(join(dir, '보낼 것'));

    expect(await resolve('보낼 것/회신.pdf')).toBe(join(dir, '보낼 것', '회신.pdf'));
    expect(await resolve('~/회신.pdf')).toBe(join(home, '회신.pdf'));
  });

  it('확장자가 없으면 .pdf 를 붙이고, .pdf 가 아닌 확장자는 거부한다', async () => {
    expect(await resolve('회신')).toBe(join(dir, '회신.pdf'));
    expect(await resolve('회신.PDF')).toBe(join(dir, '회신.PDF'));
    await expect(resolve('회신.docx')).rejects.toThrow('PDF 로만 내보냅니다(.docx). 경로를 .pdf 로 끝내거나 확장자를 빼세요.');
  });

  it('.hwp·.hwpx 경로는 overwrite 여도 거부한다(PDF 로 한글 문서를 덮지 않게)', async () => {
    await expect(resolve(document, true)).rejects.toThrow('한글 문서(.hwpx) 경로에는 PDF 를 쓰지 않습니다. 경로를 .pdf 로 끝내세요.');
    await expect(resolve('새 문서.HWP')).rejects.toThrow('한글 문서(.HWP) 경로에는 PDF 를 쓰지 않습니다. 경로를 .pdf 로 끝내세요.');
  });

  it('한글 문서를 가리키는 .pdf 이름의 링크도 덮어쓰지 않는다', async () => {
    await symlink(document, join(dir, '링크.pdf'));

    await expect(resolve('링크.pdf', true)).rejects.toThrow(`한글 문서(.hwpx) 경로에는 PDF 를 쓰지 않습니다. 경로를 .pdf 로 끝내세요.`);
  });

  it('이미 있는 파일은 overwrite: true 일 때만 덮어쓴다', async () => {
    const existing = join(dir, '회신.pdf');
    await writeFile(existing, '');

    await expect(resolve('회신.pdf')).rejects.toThrow(`이미 있는 파일입니다: ${existing}. 덮어쓰려면 overwrite: true 를 주세요.`);
    expect(await resolve('회신.pdf', true)).toBe(existing);
  });

  it('폴더·없는 폴더는 거부한다', async () => {
    await mkdir(join(dir, '폴더'));

    await expect(resolve('폴더/')).rejects.toThrow(`폴더입니다: ${join(dir, '폴더')}`);
    await expect(resolve('없는 폴더/회신.pdf')).rejects.toThrow(`저장할 폴더가 없습니다: ${join(dir, '없는 폴더')}`);
  });

  it('기본 이름 쓰기는 그사이 같은 이름이 생기면 다음 번호로 배타적으로 만든다', async () => {
    const first = join(dir, '공문.pdf');
    const target = { path: first, overwrite: false, numbered: true, next: nextPdfName(join(dir, '공문')) };
    const written = await Promise.all([writeSave(target, new TextEncoder().encode('첫째')), writeSave(target, new TextEncoder().encode('둘째'))]);

    expect(written.sort()).toEqual([join(dir, '공문-2.pdf'), first].sort());
    expect(await readFile(join(dir, '공문-2.pdf'), 'utf8')).not.toBe(await readFile(first, 'utf8'));
  });
});
