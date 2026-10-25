import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, basename } from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadFactory, missingMode } from './support/harness.ts';

test('development exposes missing implementation; release must fail', () => {
  assert.equal(missingMode(false), 'todo');
  assert.equal(missingMode(true), 'fail');
});
test('an implemented capability executes assertions and tears down even on failure', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'aw-harness-'));
  assert.equal(dirname(resolve(dir)), resolve(tmpdir()));
  assert.match(basename(dir), /^aw-harness-/);
  t.after(() => rm(dir, { recursive: true, force: true }));
  const adapter = join(dir, 'faulty.mjs');
  const disposed = join(dir, 'disposed.txt');
  await writeFile(adapter, `import { writeFile } from 'node:fs/promises';
export async function createHarness() {
  return { egress: { async check() { return {allowed: false, outbound: []}; } },
    async dispose() { await writeFile(${JSON.stringify(disposed)}, 'disposed'); } };
}`);
  const spec = join(dir, 'assertion-fails.mjs');
  await writeFile(spec, `import assert from 'node:assert/strict';
import { contract } from ${JSON.stringify(new URL('./support/harness.ts', import.meta.url).href)};
contract('egress', 'actual assertion failure', async driver => {
  assert.equal((await driver.check({})).allowed, true, 'deliberately-broken-capability');
});`);
  for (const strict of ['0', '1']) {
    const childEnv = { ...process.env, AW_TEST_ADAPTER: adapter, AW_STRICT_TESTS: strict };
    delete childEnv.NODE_TEST_CONTEXT;
    const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', spec], {
      env: childEnv, encoding: 'utf8', timeout: 10000
    });
    assert.ifError(r.error);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /deliberately-broken-capability/);
    assert.equal(await readFile(disposed, 'utf8'), 'disposed');
  }
});
test('missing adapter is distinct from an adapter import failure', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'aw-harness-'));
  assert.equal(dirname(resolve(dir)), resolve(tmpdir()));
  assert.match(basename(dir), /^aw-harness-/);
  t.after(() => rm(dir, { recursive: true, force: true }));
  assert.equal(await loadFactory(join(dir, 'missing.mjs')), undefined);
  await writeFile(join(dir, 'broken.mjs'), 'throw new Error("adapter-broken");');
  await assert.rejects(loadFactory(join(dir, 'broken.mjs')), /adapter-broken/);
  await writeFile(join(dir, 'wrong.mjs'), 'export const incorrect = true;');
  await assert.rejects(loadFactory(join(dir, 'wrong.mjs')), /createHarness/);
});
test('partial application adapters produce TODO in development and failure in release', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'aw-harness-'));
  assert.equal(dirname(resolve(dir)), resolve(tmpdir()));
  assert.match(basename(dir), /^aw-harness-/);
  t.after(() => rm(dir, { recursive: true, force: true }));
  const adapter = join(dir, 'partial.mjs');
  await writeFile(adapter, 'export async function createHarness(){return {async dispose(){}}}');
  const spec = join(dir, 'missing-capability.mjs');
  await writeFile(spec, `import { contract } from ${JSON.stringify(new URL('./support/harness.ts', import.meta.url).href)};
contract('egress', 'must not appear implemented', async () => { throw new Error('unreachable'); });`);
  for (const strict of ['0', '1']) {
    const childEnv = { ...process.env, AW_TEST_ADAPTER: adapter, AW_STRICT_TESTS: strict };
    // A nested Node test runner otherwise inherits the parent's binary reporting channel.
    delete childEnv.NODE_TEST_CONTEXT;
    const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', spec], {
      env: childEnv, encoding: 'utf8', timeout: 10000
    });
    assert.ifError(r.error);
    assert.equal(r.status, strict === '1' ? 1 : 0, r.stdout + r.stderr);
    assert.match(r.stdout, strict === '1' ? /Missing capability: egress/ : /# TODO/);
    assert.doesNotMatch(r.stdout, /unreachable/);
  }
});
