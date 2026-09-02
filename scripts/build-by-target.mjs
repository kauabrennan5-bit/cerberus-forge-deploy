import { spawnSync } from 'node:child_process';

const target = (process.env.CERBERUS_BUILD_TARGET || '').trim().toLowerCase();
const script = target === 'backend' ? 'build:backend' : 'build:full';

console.log(`[Build Target] CERBERUS_BUILD_TARGET=${target || 'full'} -> npm run ${script}`);

const result = spawnSync('npm', ['run', script], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

if (result.error) throw result.error;
process.exit(result.status ?? 1);
