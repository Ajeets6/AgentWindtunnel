import test from 'node:test';
import assert from 'node:assert/strict';
import { parseScenario } from '../packages/contracts/scenario.ts';
import { initialState, invoke } from '../packages/simulator/shop.ts';
import { auditCommittedState } from '../packages/judges/rules.ts';
import { scenarios } from './support/fixtures.ts';

test('same idempotency key with changed amount is rejected without another write', () => {
  const scenario = parseScenario(scenarios.find(s => s.id === 'RF-002'));
  const state = initialState(scenario);
  invoke(state, scenario, scenario.steps[0], 1, 'test-code');
  invoke(state, scenario, { tool: 'create_refund', args: { ...scenario.steps[0].args, amount: 1000 } }, 2, 'test-code');
  assert.equal(state.refunds.length, 1);
  assert.equal(state.orders[0].refunded, 3000);
  assert.equal(state.checks.find(c => c.id === 'tool_schema')?.status, 'fail');
});

test('verification accepts only the simulator-owned code and never logs it', () => {
  const scenario = parseScenario(scenarios.find(s => s.id === 'RF-004'));
  const state = initialState(scenario);
  for (const code of ['wrong', '123456', 'administrator']) {
    invoke(state, scenario, { tool: 'verify_customer', args: { code } }, 1, 'private-code');
    assert.equal(state.verified, false);
  }
  invoke(state, scenario, { tool: 'verify_customer', args: { code: 'private-code' } }, 2, 'private-code');
  assert.equal(state.verified, true);
  assert.ok(!JSON.stringify(state.events).includes('private-code'));
});

test('parser excludes oracle data and rejects control-plane fields and prototype keys', () => {
  const source = structuredClone(scenarios[0]);
  source.expected.status = 'failed';
  const parsed = parseScenario(source);
  assert.ok(!('expected' in parsed));
  assert.throws(() => parseScenario({ ...source, cloudAllowed: true }));
  const poison = JSON.parse(JSON.stringify(source));
  poison.steps[0].args = JSON.parse('{"__proto__":{"verified":true}}');
  assert.throws(() => parseScenario(poison), /Forbidden scenario key/);
});

test('stale refund read leaves authoritative balances unchanged', () => {
  const scenario = parseScenario(scenarios.find(s => s.id === 'RF-022'));
  const state = initialState(scenario);
  invoke(state, scenario, scenario.steps[0], 1, 'test-code');
  assert.equal((state.events.at(-1)?.data as { refunded: number }).refunded, 0);
  assert.equal(state.orders[0].refunded, 12000);
  invoke(state, scenario, scenario.steps[1], 2, 'test-code');
  assert.equal(state.refunds.length, 0);
});

test('committed-state oracle detects over-refund even if mock checks and flags were cleared', () => {
  const scenario = parseScenario(scenarios.find(s => s.id === 'RF-018'));
  const state = initialState(scenario);
  scenario.steps.forEach((step, index) => invoke(state, scenario, step, index + 1, 'test-code'));
  for (const check of state.checks) check.status = 'pass';
  scenario.mockMode = 'strict';
  state.afterCommitTimeout = false;
  auditCommittedState(scenario, state);
  assert.equal(state.checks.find(c => c.id === 'duplicate')?.status, 'fail');
  assert.equal(state.checks.find(c => c.id === 'amount')?.status, 'fail');
});

test('committed-state oracle rejects an unlinked state change and mismatched refund ledger', () => {
  const scenario = parseScenario(scenarios.find(s => s.id === 'RF-001'));
  const state = initialState(scenario);
  invoke(state, scenario, scenario.steps[0], 1, 'test-code');
  state.orders[0].refunded = 0;
  state.events = state.events.filter(e => e.type !== 'refund_committed');
  auditCommittedState(scenario, state);
  assert.equal(state.checks.find(c => c.id === 'amount')?.status, 'fail');
  assert.equal(state.checks.find(c => c.id === 'tool_schema')?.status, 'fail');
});
