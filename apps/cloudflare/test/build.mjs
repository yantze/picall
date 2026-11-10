import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const cli = fileURLToPath(
  new URL('bin/wrangler.js', import.meta.resolve('wrangler/package.json')),
);
for (const entry of ['test/mock-worker.ts', 'test/legacy-worker.ts']) {
const result = spawnSync(
  process.execPath,
  [
    cli,
    'deploy',
    entry,
    '--config',
    root + 'test/wrangler.jsonc',
    '--dry-run',
    '--outdir',
    root + 'test-dist',
  ],
  { cwd: root, stdio: 'inherit' },
);
if (result.status !== 0) process.exit(result.status ?? 1);
}
