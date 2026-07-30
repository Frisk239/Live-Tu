import { spawnSync } from 'node:child_process';

const files = process.argv.slice(2);
if (files.length === 0) {
  throw new Error('At least one paid E2E spec path is required');
}

const executable = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const result = spawnSync(executable, ['playwright', 'test', ...files], {
  cwd: process.cwd(),
  env: { ...process.env, E2E_ALLOW_PAID: 'true' },
  stdio: 'inherit',
});
process.exit(result.status ?? 1);
