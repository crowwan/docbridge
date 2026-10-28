// HWPX(zip) 안 파일을 읽고 다시 묶는 최소 도우미 — rhwp 편집 API 로 만들 수 없는 fixture(구역 둘)를 만들 때(make-fixtures.ts),
// 그리고 테스트가 HWPX 안 XML 을 고쳐 보거나 들여다볼 때(tests/paragraph-layout.test.ts 줄 배치 빼기·tests/hwpx-zip.test.ts) 쓴다.
// 압축은 저장(0)·deflate(8)만, zip64·암호·데이터 설명자는 없다(rhwp 가 내보낸 HWPX 가 이 모양이다).
import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib';

export interface ZipEntry {
  name: string;
  data: Uint8Array;
  /** 0 = 저장(mimetype), 8 = deflate */
  method: 0 | 8;
}

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL = 0x06054b50;
/** 1980-01-01 00:00 (DOS 날짜) — 다시 만들 때마다 같은 바이트가 나오게 */
const DOS_DATE = 0x21;

/** zip 의 파일을 중앙 디렉터리 순서대로 읽는다 */
export function readZip(bytes: Uint8Array): ZipEntry[] {
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = view.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0 || view.readUInt32LE(end) !== END_OF_CENTRAL) throw new Error('zip 끝 레코드가 없다');
  const count = view.readUInt16LE(end + 10);
  let at = view.readUInt32LE(end + 16);
  const entries: ZipEntry[] = [];
  for (let i = 0; i < count; i += 1) {
    if (view.readUInt32LE(at) !== CENTRAL_HEADER) throw new Error(`중앙 디렉터리 ${i} 가 깨졌다`);
    const method = view.readUInt16LE(at + 10);
    const size = view.readUInt32LE(at + 20);
    const nameLength = view.readUInt16LE(at + 28);
    const extraLength = view.readUInt16LE(at + 30);
    const commentLength = view.readUInt16LE(at + 32);
    const local = view.readUInt32LE(at + 42);
    const name = view.toString('utf8', at + 46, at + 46 + nameLength);
    if (view.readUInt32LE(local) !== LOCAL_HEADER) throw new Error(`${name} 의 로컬 헤더가 깨졌다`);
    const start = local + 30 + view.readUInt16LE(local + 26) + view.readUInt16LE(local + 28);
    const stored = view.subarray(start, start + size);
    if (method !== 0 && method !== 8) throw new Error(`${name}: 모르는 압축 방식 ${method}`);
    entries.push(method === 0 ? { name, method: 0, data: new Uint8Array(stored) } : { name, method: 8, data: new Uint8Array(inflateRawSync(stored)) });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** 파일을 차례대로 zip 으로 묶는다(HWPX 는 mimetype 이 맨 앞, 저장 방식이어야 한다) */
export function writeZip(entries: ZipEntry[]): Uint8Array {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const { name, data, method } of entries) {
    const nameBytes = Buffer.from(name, 'utf8');
    const body = method === 0 ? Buffer.from(data) : deflateRawSync(data);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_HEADER, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL_HEADER, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, body);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + body.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END_OF_CENTRAL, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, directory, end]));
}

const textOf = (entries: ZipEntry[], name: string) => {
  const entry = entries.find((e) => e.name === name);
  if (entry === undefined) throw new Error(`HWPX 에 ${name} 가 없다`);
  return Buffer.from(entry.data).toString('utf8');
};

/** 한 곳을 바꾸되, 바꿀 글자는 꼭 한 번 나와야 한다 — rhwp 가 내보내는 모양이 바뀌면 조용히 넘어가지 않고 멈춘다 */
const replaceOnce = (text: string, from: string, to: string, where: string) => {
  const at = text.indexOf(from);
  if (at < 0 || text.indexOf(from, at + 1) >= 0) throw new Error(`${where} 에서 ${from} 을 한 번만 찾지 못했다`);
  return text.slice(0, at) + to + text.slice(at + from.length);
};

const SECTION0_RDF =
  '<rdf:Description rdf:about=""><ns0:hasPart xmlns:ns0="http://www.hancom.co.kr/hwpml/2016/meta/pkg#" rdf:resource="Contents/section0.xml"/></rdf:Description><rdf:Description rdf:about="Contents/section0.xml"><rdf:type rdf:resource="http://www.hancom.co.kr/hwpml/2016/meta/pkg#SectionFile"/></rdf:Description>';

/**
 * 두 HWPX 를 구역 둘인 HWPX 하나로: first 에 second 의 구역 0 을 구역 1 로 붙인다.
 * 구역 목록은 모두 맞춘다 — header.xml secCnt, META-INF/container.rdf(구역 파일 항목), content.hpf(manifest·spine). 한컴은 이 목록으로 구역을 읽는다(#111).
 * 머리(header.xml — 글자·문단 모양 표)는 first 것을 쓰므로 second 는 first 와 같은 모양 번호만 쓰는 문서여야 한다(둘 다 기본 모양만 쓴 문서)
 */
export function joinSections(first: Uint8Array, second: Uint8Array): Uint8Array {
  const entries = readZip(first);
  const section1 = textOf(readZip(second), 'Contents/section0.xml');
  const changed = new Map<string, string>([
    ['Contents/header.xml', replaceOnce(textOf(entries, 'Contents/header.xml'), 'secCnt="1"', 'secCnt="2"', 'header.xml')],
    ['META-INF/container.rdf', replaceOnce(textOf(entries, 'META-INF/container.rdf'), SECTION0_RDF, SECTION0_RDF + SECTION0_RDF.replaceAll('section0.xml', 'section1.xml'), 'container.rdf')],
    [
      'Contents/content.hpf',
      replaceOnce(
        replaceOnce(
          textOf(entries, 'Contents/content.hpf'),
          '<opf:item id="section0" href="Contents/section0.xml" media-type="application/xml"/>',
          '<opf:item id="section0" href="Contents/section0.xml" media-type="application/xml"/><opf:item id="section1" href="Contents/section1.xml" media-type="application/xml"/>',
          'content.hpf manifest',
        ),
        '<opf:itemref idref="section0" linear="yes"/>',
        '<opf:itemref idref="section0" linear="yes"/><opf:itemref idref="section1" linear="yes"/>',
        'content.hpf spine',
      ),
    ],
  ]);
  const added: ZipEntry = { name: 'Contents/section1.xml', method: 8, data: new Uint8Array(Buffer.from(section1, 'utf8')) };
  return writeZip(
    entries.flatMap((entry): ZipEntry[] => {
      const text = changed.get(entry.name);
      if (text !== undefined) return [{ ...entry, data: new Uint8Array(Buffer.from(text, 'utf8')) }];
      if (entry.name === 'Contents/section0.xml') return [entry, added];
      return [entry];
    }),
  );
}
