import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExecutionStore } from '../packages/runner/store.ts';
import { Runner } from '../packages/runner/runner.ts';
import { Budget } from '../packages/runner/budget.ts';
import { scenarios } from './support/fixtures.ts';

async function storage(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'aw-integration-'));
  const stores: ExecutionStore[] = [];
  t.after(async () => {
    for (const store of stores) store.close();
    await rm(directory, { recursive: true, force: true });
  });
  return () => {
    const store = new ExecutionStore(join(directory, 'test.sqlite'));
    stores.push(store);
    return store;
  };
}

test('default runner cannot accept semantic fixture stubs as trusted judgments', async t => {
  const store = (await storage(t))();
  const result = await new Runner(store).run(scenarios.find(s => s.id === 'RF-001'));
  assert.equal(result.status, 'needs_review');
  assert.equal(result.refunds.length, 1);
  assert.equal(result.checks.find(c => c.id === 'message_truth')?.status, 'needs_review');
});

test('crash checkpoint resumes at next step with one commit and original ledger', async t => {
  const open = await storage(t);
  const store = open();
  const runner = new Runner(store);
  const fixture = scenarios.find(s => s.id === 'RF-017')!;
  const id = runner.start(fixture);
  await assert.rejects(runner.resume(id, { onCheckpoint() { throw new Error('worker stopped'); } }), /worker stopped/);
  const checkpoint = store.load(id);
  assert.equal(checkpoint.cursor, 1);
  assert.equal(checkpoint.state.refunds.length, 1);
  const resumed = await new Runner(open()).resume(id);
  assert.equal(resumed.refunds.length, 1);
  assert.equal(resumed.events.filter(e => e.type === 'refund_committed').length, 1);
  assert.equal(resumed.refunds[0].operationId, checkpoint.state.refunds[0].operationId);
  assert.deepEqual(await runner.resume(id), resumed, 'Completed executions must not append or replay');
});

test('competing workers cannot overwrite a newer checkpoint', async t => {
  const open = await storage(t);
  const first = open();
  const second = open();
  const id = new Runner(first).start(scenarios[0]);
  const a = first.load(id);
  const b = second.load(id);
  a.cursor = 1;
  first.save(a);
  assert.throws(() => second.save(b), /checkpoint conflict/);
  assert.equal(second.load(id).cursor, 1);
});

test('cancellation before dispatch executes no tools or providers', async t => {
  const runner = new Runner((await storage(t))());
  const controller = new AbortController();
  controller.abort();
  const result = await runner.run(scenarios[0], {
    signal: controller.signal,
    guard: async () => { throw new Error('Guard must not run'); },
  });
  assert.equal(result.status, 'cancelled');
  assert.equal(result.events.filter(e => e.type === 'tool_called').length, 0);
  assert.equal(result.refunds.length, 0);
});

test('a calibrated judge cannot erase a deterministic business failure', async t => {
  const runner = new Runner((await storage(t))());
  const result = await runner.run(scenarios.find(s => s.id === 'RF-004'), {
    guard: async () => 'safe', judge: async () => ({ label: 'consistent', calibrated: true }),
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.checks.find(c => c.id === 'identity')?.status, 'fail');
});

test('retry exhaustion stops additional scripted writes', async t => {
  const fixture = structuredClone(scenarios.find(s => s.id === 'RF-014')!);
  fixture.steps.push(fixture.steps[0]);
  const result = await new Runner((await storage(t))()).run(fixture);
  assert.equal(result.refunds.length, 0);
  assert.equal(result.events.filter(e => e.type === 'tool_called').length, 3);
  assert.equal(result.status, 'failed');
});

test('budget settlement accounts for spend without admitting excess concurrent reservations', async () => {
  const budget = new Budget(100);
  const accepted = await Promise.all(Array.from({ length: 10 }, async (_, i) => budget.reserve(`${i}`, 30)));
  assert.equal(accepted.filter(Boolean).length, 3);
  budget.settle('0', 20);
  assert.equal(budget.reserve('next', 21), false);
  assert.equal(budget.reserve('next', 20), true);
  assert.throws(() => budget.settle('1', 31), /Invalid settlement/);
  assert.equal(budget.reserved, 80);
});
