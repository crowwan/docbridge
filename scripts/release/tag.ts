// Release 워크플로(.github/workflows/release.yml)의 태그·버전 확인(SPEC-004 릴리스 흐름)
import { mcpbFileName } from '../pack/manifest.ts';

/**
 * 태그(v0.2.0)가 package.json 버전(0.2.0)과 같으면 Release 에 올릴 파일(레포 기준 상대 경로)을 돌려준다.
 * 다르면 실패 — 버전 올리기를 빼먹은 태그로 엉뚱한 버전의 .mcpb 를 올리지 않게
 */
export function releaseFile(tag: string, version: string): string {
  const expected = `v${version}`;
  if (tag !== expected) {
    throw new Error(`태그 ${tag} 와 package.json 버전 ${version} 이 다릅니다. 태그는 ${expected} 이어야 합니다`);
  }
  return `dist/${mcpbFileName(version)}`;
}
