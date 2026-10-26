import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

const fixturesDir = fileURLToPath(new URL('./fixtures/', import.meta.url));
// 레포에 넣지 않는 문서로 로컬 측정할 때만 쓰는 추가 폴더(선택)
const extraFixturesDir = process.env['DOCBRIDGE_EXTRA_FIXTURES_DIR'];

// 개발 서버에서만 /fixtures/<이름> 으로 테스트 문서를 내준다. 빌드 결과에는 넣지 않는다.
function serveFixtures(): Plugin {
  return {
    name: 'docbridge-fixtures',
    configureServer(server) {
      server.middlewares.use('/fixtures', (req, res, next) => {
        const name = decodeURIComponent((req.url ?? '').replace(/^\//, '').split('?')[0] ?? '');
        if (!/^[\w.-]+\.hwpx?$/.test(name)) {
          next();
          return;
        }
        readFile(`${fixturesDir}${name}`)
          .catch((error: unknown) => {
            if (extraFixturesDir === undefined) throw error;
            return readFile(`${extraFixturesDir}/${name}`);
          })
          .then(
          (body) => {
            res.setHeader('content-type', 'application/octet-stream');
            res.end(body);
          },
          () => {
            res.statusCode = 404;
            res.end();
          },
        );
      });
    },
  };
}

export default defineConfig({
  root: 'src/viewer',
  plugins: [serveFixtures()],
  optimizeDeps: { exclude: ['@rhwp/core'] },
  server: { host: '127.0.0.1', port: 7791, strictPort: true },
  preview: { host: '127.0.0.1', port: 7791, strictPort: true },
  build: { outDir: '../../dist/viewer', emptyOutDir: true },
});
