import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';

const files = readdirSync(new URL('../tests/', import.meta.url))
  .filter(name => name.endsWith('.test.ts')).sort().map(name => `tests/${name}`);
const args = ['--test', ...(process.argv.includes('--watch') ? ['--watch'] : []), ...files];
const result = spawnSync(process.execPath, args, {
  cwd: new URL('../', import.meta.url), stdio: 'inherit',
  env: { ...process.env, AW_STRICT_TESTS: process.argv.includes('--strict') ? '1' : '0' }
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
