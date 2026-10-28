// HWPX(zip) 안 파일을 읽고 다시 묶는 최소 도우미 — rhwp 편집 API 로 만들 수 없는 fixture(구역 둘)를 만들 때만 쓴다(make-fixtures.ts).
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

/**
 * 두 HWPX 를 구역 둘인 HWPX 하나로: first 에 second 의 구역 0 을 구역 1 로 붙인다.
 * 머리(header.xml — 글자·문단 모양 표)는 first 것을 쓰므로 second 는 first 와 같은 모양 번호만 쓰는 문서여야 한다(둘 다 기본 모양만 쓴 문서)
 */
export function joinSections(first: Uint8Array, second: Uint8Array): Uint8Array {
  const entries = readZip(first);
  const section1 = textOf(readZip(second), 'Contents/section0.xml');
  const manifest = textOf(entries, 'Contents/content.hpf')
    .replace(
      '<opf:item id="section0" href="Contents/section0.xml" media-type="application/xml"/>',
      '<opf:item id="section0" href="Contents/section0.xml" media-type="application/xml"/><opf:item id="section1" href="Contents/section1.xml" media-type="application/xml"/>',
    )
    .replace('<opf:itemref idref="section0" linear="yes"/>', '<opf:itemref idref="section0" linear="yes"/><opf:itemref idref="section1" linear="yes"/>');
  if (!manifest.includes('section1.xml') || !manifest.includes('idref="section1"')) throw new Error('content.hpf 에 구역 1 을 넣지 못했다');
  const added: ZipEntry = { name: 'Contents/section1.xml', method: 8, data: new Uint8Array(Buffer.from(section1, 'utf8')) };
  return writeZip(
    entries.flatMap((entry): ZipEntry[] => {
      if (entry.name === 'Contents/content.hpf') return [{ ...entry, data: new Uint8Array(Buffer.from(manifest, 'utf8')) }];
      if (entry.name === 'Contents/section0.xml') return [entry, added];
      return [entry];
    }),
  );
}
