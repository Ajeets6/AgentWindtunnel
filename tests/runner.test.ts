import assert from 'node:assert/strict';
import { contract } from './support/harness.ts';
import { scenarios } from './support/fixtures.ts';

for (const fixture of scenarios) contract('runner', `${fixture.id}: ${fixture.title}`, async driver => {
  const input = structuredClone(fixture);
  const before = structuredClone(input);
  const result = await driver.run(input);
  assert.deepEqual(input, before, 'Runner mutated the immutable fixture');
  assert.equal(result.status, fixture.expected.status);
  assert.equal(result.refunds.length, fixture.expected.refundsCreated);
  assert.equal(result.refunds.reduce((sum, r) => sum + r.amount, 0), fixture.expected.newRefundAmount);
  assert.deepEqual([...new Set(result.refunds.map(r => r.orderId))].sort(), [...fixture.expected.touchedOrders].sort());
  const required = result.checks.filter(c => c.required);
  for (const id of ['identity', 'ownership', 'policy', 'amount', 'duplicate', 'target_order', 'tool_schema'])
    assert.ok(required.some(c => c.id === id), `Missing required business assertion: ${id}`);
  assert.deepEqual(required.filter(c => c.status === 'fail').map(c => c.id).sort(), [...fixture.expected.failedChecks].sort());
  assert.deepEqual(required.filter(c => c.status === 'needs_review').map(c => c.id).sort(), [...fixture.expected.reviewChecks].sort());
  assert.ok(result.executionId);
  assert.ok(result.events.length >= fixture.steps.length);
  assert.equal(new Set(result.events.map(e => e.id)).size, result.events.length);
  assert.deepEqual(result.events.map(e => e.sequence), result.events.map((_, i) => i + 1));
  assert.deepEqual(result.outbound, [], 'Scripted regression fixtures require no inference/network');
  for (const refund of result.refunds) {
    assert.ok(Number.isSafeInteger(refund.amount) && refund.amount > 0);
    assert.ok(result.events.some(e => e.type === 'refund_committed' && e.operationId === refund.operationId));
  }
});

for (const action of ['cancel', 'recover-after-commit', 'isolation', 'turn-limit', 'budget-race'] as const)
  contract('runner', `lifecycle ${action}`, async driver => {
    const r = await driver.lifecycle(action);
    if (action === 'cancel') { assert.equal(r.status, 'cancelled'); assert.equal(r.callsAfterStop, 0); }
    if (action === 'recover-after-commit') assert.equal(r.refundsCreated, 1, 'Recovery replayed a committed write');
    if (action === 'isolation') assert.equal(r.isolated, true);
    if (action === 'turn-limit') { assert.equal(r.status, 'error'); assert.equal(r.callsAfterStop, 0); }
    if (action === 'budget-race') { assert.ok(r.reservedCost > 0); assert.ok(r.reservedCost <= r.budget); }
    assert.deepEqual(r.outbound, [], 'Use controlled transports, never a paid API');
  });
