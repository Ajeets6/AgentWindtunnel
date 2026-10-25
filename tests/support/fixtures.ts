import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import type { Scenario } from './contracts.ts';

export const families = ['happy', 'identity', 'policy', 'selection', 'timeout-before',
  'timeout-after', 'rate-limit', 'stale', 'language', 'adversarial'];
export const checkIds = ['identity', 'ownership', 'policy', 'amount', 'duplicate',
  'target_order', 'message_truth', 'injection', 'retry_limit', 'tool_schema'];
const statuses = ['passed', 'failed', 'needs_review', 'error', 'cancelled'];
export function validateScenario(s: Scenario) {
  assert.match(s.id, /^RF-\d{3}$/);
  assert.ok(families.includes(s.family));
  assert.ok(s.title.length > 5);
  assert.ok(Number.isSafeInteger(s.version) && s.version > 0);
  assert.equal(s.policyVersion, 'p1');
  assert.ok(Number.isSafeInteger(s.retryLimit) && s.retryLimit > 0 && s.retryLimit <= 10);
  assert.ok(['strict', 'duplicate-after-timeout'].includes(s.mockMode));
  assert.ok(['safe', 'suspicious', 'unavailable'].includes(s.guardStub));
  assert.ok(['consistent', 'contradiction', 'insufficient_evidence'].includes(s.judgeStub.label));
  assert.equal(typeof s.judgeStub.calibrated, 'boolean');
  assert.ok(Number.isFinite(Date.parse(s.initial.now)));
  assert.equal(typeof s.initial.verified, 'boolean');
  assert.ok(s.initial.customerId && s.initial.requestedOrderId);
  const ids = s.initial.orders.map(o => o.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.includes(s.initial.requestedOrderId));
  for (const order of s.initial.orders) {
    for (const key of ['paid', 'refunded', 'ageDays', 'eligibleAmount'] as const)
      assert.ok(Number.isSafeInteger(order[key]) && order[key] >= 0, `Invalid ${key}`);
    assert.ok(order.refunded <= order.paid);
    assert.ok(order.eligibleAmount <= order.paid - order.refunded);
  }
  assert.ok(s.messages.length > 0 && s.messages.every(m => typeof m === 'string'));
  assert.equal(typeof s.finalMessage, 'string');
  assert.ok(s.steps.every(step => ['create_refund', 'get_refund_status', 'wait', 'verify_customer']
    .includes(step.tool) && step.args && typeof step.args === 'object' && !Array.isArray(step.args)));
  assert.equal(new Set(s.faults.map(f => f.call)).size, s.faults.length, 'Conflicting faults at one step');
  for (const fault of s.faults) {
    assert.ok(['timeout', 'rate_limit', 'stale_read'].includes(fault.kind));
    assert.ok(Number.isInteger(fault.call) && fault.call > 0 && fault.call <= s.steps.length);
    if (fault.kind === 'timeout') assert.ok(['before_commit', 'after_commit'].includes(fault.phase!));
    assert.equal(s.steps[fault.call - 1].tool, fault.kind === 'stale_read' ? 'get_refund_status' : 'create_refund');
    if (fault.kind === 'stale_read') assert.ok(fault.value && typeof fault.value === 'object' && !Array.isArray(fault.value));
  }
  assert.ok(statuses.includes(s.expected.status));
  assert.ok(Number.isSafeInteger(s.expected.refundsCreated) && s.expected.refundsCreated >= 0);
  assert.ok(Number.isSafeInteger(s.expected.newRefundAmount) && s.expected.newRefundAmount >= 0);
  for (const id of [...s.expected.failedChecks, ...s.expected.reviewChecks]) assert.ok(checkIds.includes(id));
  assert.equal(new Set([...s.expected.failedChecks, ...s.expected.reviewChecks]).size,
    s.expected.failedChecks.length + s.expected.reviewChecks.length);
  for (const id of s.expected.touchedOrders) assert.ok(ids.includes(id));
  assert.equal(new Set(s.expected.touchedOrders).size, s.expected.touchedOrders.length);
  if (s.expected.refundsCreated === 0) {
    assert.equal(s.expected.newRefundAmount, 0);
    assert.deepEqual(s.expected.touchedOrders, []);
  } else {
    assert.ok(s.expected.newRefundAmount >= s.expected.refundsCreated);
    assert.ok(s.expected.touchedOrders.length > 0 && s.expected.touchedOrders.length <= s.expected.refundsCreated);
  }
  if (s.expected.status === 'failed') assert.ok(s.expected.failedChecks.length > 0);
  if (s.expected.status === 'needs_review') {
    assert.ok(s.expected.reviewChecks.length > 0);
    assert.deepEqual(s.expected.failedChecks, []);
  }
  if (s.expected.status === 'passed') assert.deepEqual([s.expected.failedChecks, s.expected.reviewChecks], [[], []]);
}
const directory = new URL('../../scenarios/refunds/', import.meta.url);
export const initialScenarios: Scenario[] = JSON.parse(readFileSync(new URL('initial.json', directory), 'utf8'));
export const scenarios: Scenario[] = readdirSync(directory).filter(name => name.endsWith('.json')).sort()
  .flatMap(name => JSON.parse(readFileSync(new URL(name, directory), 'utf8')));
