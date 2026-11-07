import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const cli = fileURLToPath(
  new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url),
);
const result = spawnSync(
  process.execPath,
  [
    cli,
    'deploy',
    '--config',
    root + 'test/wrangler.jsonc',
    '--dry-run',
    '--outdir',
    root + 'test-dist',
  ],
  { cwd: root, stdio: 'inherit' },
);
process.exit(result.status ?? 1);
