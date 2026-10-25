import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { junit } from '../packages/cli/report.ts';
import type { Report } from '../packages/cli/report.ts';

async function command(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'aw-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return (args: string[]) => {
    const childEnv = { ...process.env };
    delete childEnv.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, ['packages/cli/main.ts', '--db', join(directory, 'runs.sqlite'), ...args], {
      cwd: resolve(import.meta.dirname, '..'), encoding: 'utf8', env: childEnv, timeout: 15000,
    });
    assert.ifError(result.error);
    return result;
  };
}

test('CLI repeats real scripted runs and exports snapshots and distinct execution IDs', async t => {
  const child = (await command(t))(['--scenario', 'RF-001', '--fixture-judges', '--repeats', '2']);
  assert.equal(child.status, 0, child.stderr);
  const suite: Report = JSON.parse(child.stdout);
  assert.equal(suite.judgeMode, 'fixture-stubs');
  assert.equal(suite.counts.passed, 2);
  assert.equal(new Set(suite.runs.map(r => r.result.executionId)).size, 2);
  for (const item of suite.runs) {
    assert.equal(item.before.orders[0].refunded, 0);
    assert.equal(item.after.orders[0].refunded, 12000);
    assert.equal(item.result.refunds.length, 1);
  }
});

test('CLI default uses review and requires explicit permission for review exit success', async t => {
  const run = await command(t);
  const child = run(['--scenario', 'RF-001']);
  assert.equal(child.status, 1, child.stderr);
  assert.equal(JSON.parse(child.stdout).judgeMode, 'unverified-review');
  assert.equal(run(['--scenario', 'RF-001', '--allow-review']).status, 0);
});

test('CLI exposes duplicate refund and preserves judgment provenance on resume', async t => {
  const run = await command(t);
  const child = run(['--scenario', 'RF-018', '--fixture-judges']);
  assert.equal(child.status, 1, child.stderr);
  const suite: Report = JSON.parse(child.stdout);
  const result = suite.runs[0].result;
  assert.equal(result.refunds.length, 2);
  assert.equal(result.refunds.reduce((sum, r) => sum + r.amount, 0), 24000);
  assert.equal(result.checks.find(c => c.id === 'duplicate')?.status, 'fail');
  const resumed = run(['--resume', result.executionId]);
  assert.equal(resumed.status, 1);
  const replay: Report = JSON.parse(resumed.stdout);
  assert.equal(replay.judgeMode, 'fixture-stubs');
  assert.deepEqual(replay.runs[0].result, result);
});

test('CLI rejects invalid repeats, unknown scenarios and formats', async t => {
  const run = await command(t);
  for (const args of [['--repeats', '1.5'], ['--repeats', '101'], ['--scenario', 'missing'], ['--format', 'html']]) {
    const child = run(args);
    assert.equal(child.status, 2);
    assert.equal(child.stdout, '');
  }
});

test('CLI refuses to overwrite its SQLite database or WAL with report output', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'aw-db-guard-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const suffix of ['', '-wal', '-shm']) {
    const database = join(directory, 'runs.sqlite');
    const result = spawnSync(process.execPath, ['packages/cli/main.ts', '--db', database,
      '--output', database + suffix, '--scenario', 'RF-001'], { encoding: 'utf8', timeout: 15000 });
    assert.ifError(result.error);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /cannot overwrite the database/);
  }
});

test('JUnit escapes untrusted scenario titles and marks unresolved checks skipped', async t => {
  const child = (await command(t))(['--scenario', 'RF-001']);
  const suite: Report = JSON.parse(child.stdout);
  suite.runs[0].title = '<script x="1">&bad\u0000</script>';
  const xml = junit(suite);
  assert.ok(!xml.includes('<script'));
  assert.ok(!xml.includes('\u0000'));
  assert.ok(xml.includes('&lt;script x=&quot;1&quot;&gt;&amp;bad'));
  assert.ok(xml.includes('skipped="1"'));
  assert.ok(xml.includes('<skipped message="needs_review"/>'));
});

test('CLI writes a JUnit file with failing status for a false completion claim', async t => {
  const run = await command(t);
  const directory = await mkdtemp(join(tmpdir(), 'aw-export-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'results.xml');
  const child = run(['--scenario', 'RF-025', '--fixture-judges', '--format', 'junit', '--output', path]);
  assert.equal(child.status, 1, child.stderr);
  assert.equal(child.stdout, '');
  const xml = await readFile(path, 'utf8');
  assert.ok(xml.includes('failures="1"'));
  assert.ok(xml.includes('message_truth: fail'));
});
