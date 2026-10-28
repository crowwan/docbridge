import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { joinSections, readZip, type ZipEntry } from '../scripts/hwpx-zip.ts';
import { createBlankDocument } from '../src/core/rhwp-node.ts';
import { fixturePath } from './fixtures.ts';

const textOf = (entries: ZipEntry[], name: string) => Buffer.from(entries.find((entry) => entry.name === name)?.data ?? new Uint8Array()).toString('utf8');

/** HWPX 안 구역 파일(Contents/sectionN.xml) 이름들 */
const sectionFiles = (entries: ZipEntry[]) => entries.map((entry) => entry.name).filter((name) => /^Contents\/section\d+\.xml$/.test(name));

/** HWPX 가 구역 목록을 적어 두는 곳들 — 한컴은 이 목록으로 구역을 읽는다 */
function sectionLists(bytes: Uint8Array) {
  const entries = readZip(bytes);
  const header = textOf(entries, 'Contents/header.xml');
  const rdf = textOf(entries, 'META-INF/container.rdf');
  const hpf = textOf(entries, 'Contents/content.hpf');
  const ids = [...hpf.matchAll(/<opf:item id="([^"]+)" href="(Contents\/section\d+\.xml)"/g)];
  return {
    files: sectionFiles(entries),
    secCnt: Number(/<hh:head [^>]*secCnt="(\d+)"/.exec(header)?.[1]),
    rdfParts: [...rdf.matchAll(/<ns0:hasPart [^>]*rdf:resource="(Contents\/section\d+\.xml)"\/>/g)].map((match) => match[1]),
    rdfSectionFiles: [...rdf.matchAll(/<rdf:Description rdf:about="(Contents\/section\d+\.xml)"><rdf:type rdf:resource="[^"]*#SectionFile"\/>/g)].map((match) => match[1]),
    manifest: ids.map((match) => match[2]),
    spine: [...hpf.matchAll(/<opf:itemref idref="([^"]+)"/g)]
      .map((match) => ids.find((item) => item[1] === match[1])?.[2])
      .filter((href) => href !== undefined),
  };
}

const expectAllSectionsListed = (bytes: Uint8Array) => {
  const lists = sectionLists(bytes);
  expect(lists.files).toEqual(['Contents/section0.xml', 'Contents/section1.xml']);
  expect(lists.secCnt).toBe(lists.files.length);
  expect(lists.rdfParts).toEqual(lists.files);
  expect(lists.rdfSectionFiles).toEqual(lists.files);
  expect(lists.manifest).toEqual(lists.files);
  expect(lists.spine).toEqual(lists.files);
};

describe('SPEC-007 구역 둘 fixture 만들기(joinSections)는 HWPX 의 구역 목록을 모두 맞춘다 (#111)', () => {
  it('합친 HWPX 의 header.xml secCnt 가 구역 파일 수이고, container.rdf·content.hpf(manifest·spine) 에 모든 구역 파일이 있다', () => {
    const one = () => createBlankDocument().exportHwpx();

    expectAllSectionsListed(joinSections(one(), one()));
  });

  it('fixtures/sections.hwpx 도 구역 목록이 구역 파일과 같다(다시 만든 fixture)', () => {
    expectAllSectionsListed(new Uint8Array(readFileSync(fixturePath('sections.hwpx'))));
  });
});
