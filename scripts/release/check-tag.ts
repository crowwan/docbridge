// 실행: node scripts/release/check-tag.ts <태그>
// 태그가 package.json 버전과 같으면 Release 에 올릴 파일 경로(dist/docbridge-<버전>.mcpb)만 stdout 에 쓴다.
// 다르면 이유를 stderr 에 쓰고 1 로 끝난다(Release 워크플로가 여기서 멈춘다).
import { errorMessage } from '../../src/shared/errors.ts';
import { packageVersion } from '../pack/manifest.ts';
import { releaseFile } from './tag.ts';

const tag = process.argv[2];
try {
  if (tag === undefined || tag === '') throw new Error('태그를 주세요. 예: node scripts/release/check-tag.ts v0.2.0');
  process.stdout.write(`${releaseFile(tag, await packageVersion())}\n`);
} catch (error) {
  process.stderr.write(`${errorMessage(error)}\n`);
  process.exitCode = 1;
}
