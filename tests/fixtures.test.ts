import test from 'node:test';
import assert from 'node:assert/strict';
import { scenarios, initialScenarios, families, validateScenario } from './support/fixtures.ts';

test('initial pack has 30 unique authored scenarios across all ten design families', () => {
  assert.equal(initialScenarios.length, 30);
  assert.equal(new Set(initialScenarios.map(s => s.id)).size, 30);
  for (const family of families) assert.equal(initialScenarios.filter(s => s.family === family).length, 3);
});
test('scenario IDs remain unique across every refund pack', () => {
  assert.equal(new Set(scenarios.map(s => s.id)).size, scenarios.length);
});
for (const scenario of scenarios) test(`fixture ${scenario.id}: ${scenario.title}`, () => validateScenario(scenario));
for (const [name, mutate] of [
  ['fractional money', s => { s.initial.orders[0].paid = 0.1; }],
  ['unknown oracle check', s => { s.expected.failedChecks = ['made_up']; }],
  ['invalid fault phase', s => { s.faults = [{ kind: 'timeout', call: 1, phase: 'ambiguous' }]; }],
  ['duplicate order IDs', s => { s.initial.orders.push(s.initial.orders[0]); }],
  ['pass hiding required failure', s => { s.expected.failedChecks = ['duplicate']; }],
  ['negative expected money', s => { s.expected.newRefundAmount = -1; }],
  ['unsafe money precision', s => { s.initial.orders[0].paid = Number.MAX_SAFE_INTEGER + 1; }],
  ['invalid guard verdict', s => { s.guardStub = 'always-approve' as any; }],
  ['host bypass mock mode', s => { s.mockMode = 'disable-host-security' as any; }],
  ['unknown semantic label', s => { s.judgeStub.label = 'force-pass'; }],
  ['stale read without a value', s => { s.steps = [{ tool: 'get_refund_status', args: {} }]; s.faults = [{ kind: 'stale_read', call: 1 }]; }],
  ['fault targeting the wrong tool', s => { s.steps = [{ tool: 'wait', args: {} }]; s.faults = [{ kind: 'timeout', call: 1, phase: 'before_commit' }]; }],
  ['inconsistent expected write count', s => { s.expected.refundsCreated = 0; }],
  ['unbounded retry setting', s => { s.retryLimit = 1000000; }]
] as const) test(`fixture validator rejects ${name}`, () => {
  const changed = structuredClone(scenarios[0]);
  mutate(changed);
  assert.throws(() => validateScenario(changed));
});
