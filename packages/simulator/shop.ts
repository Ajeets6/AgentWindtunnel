import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Check, Event, Refund, Scenario, Step } from '../contracts/scenario.ts';

const identifier = z.string().min(1).max(256);
const schemas = {
  create_refund: z.strictObject({ orderId: identifier, amount: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    currency: z.literal('AUD'), idempotencyKey: identifier }),
  get_refund_status: z.strictObject({ orderId: identifier }),
  wait: z.strictObject({ milliseconds: z.number().int().min(0).max(86400000) }),
  verify_customer: z.strictObject({ code: identifier }),
};
const businessChecks = ['identity', 'ownership', 'policy', 'amount', 'duplicate', 'target_order', 'tool_schema', 'retry_limit'];
export type ShopState = {
  now: number; verified: boolean; orders: Scenario['initial']['orders']; refunds: Refund[];
  keys: Record<string, { fingerprint: string; refund: Refund }>;
  checks: Check[]; events: Event[]; consecutiveFailures: number; afterCommitTimeout: boolean;
};

export function initialState(scenario: Scenario): ShopState {
  return {
    now: Date.parse(scenario.initial.now), verified: scenario.initial.verified,
    orders: structuredClone(scenario.initial.orders), refunds: [], keys: {}, events: [],
    checks: businessChecks.map(id => ({ id, required: true, status: 'pass' })),
    consecutiveFailures: 0, afterCommitTimeout: false,
  };
}

export function append(state: ShopState, type: string, data: unknown, operationId?: string): Event {
  const event: Event = { id: randomUUID(), sequence: state.events.length + 1,
    time: new Date(state.now).toISOString(), type, data: structuredClone(data), ...(operationId ? { operationId } : {}) };
  state.events.push(event);
  return event;
}

export function fail(state: ShopState, id: string): void {
  const check = state.checks.find(c => c.id === id);
  if (!check) throw new Error(`Unknown business check ${id}`);
  check.status = 'fail';
}

/** One isolated backend invocation. The runner persists state+ledger atomically. */
export function invoke(state: ShopState, scenario: Scenario, step: Step, call: number,
  verificationCode: string): void {
  const operationId = randomUUID();
  append(state, 'tool_called', { tool: step.tool, args: step.tool === 'verify_customer' ? { code: '[REDACTED]' } : step.args }, operationId);
  const schema = schemas[step.tool as keyof typeof schemas];
  const parsed = schema?.safeParse(step.args);
  if (!parsed?.success) {
    fail(state, 'tool_schema');
    append(state, 'tool_result', { error: 'invalid_arguments' }, operationId);
    return;
  }
  if (step.tool === 'wait') {
    state.now += (parsed.data as z.infer<typeof schemas.wait>).milliseconds;
    append(state, 'tool_result', { now: new Date(state.now).toISOString() }, operationId);
    return;
  }
  if (step.tool === 'verify_customer') {
    if ((parsed.data as z.infer<typeof schemas.verify_customer>).code === verificationCode) state.verified = true;
    append(state, 'tool_result', { verified: state.verified }, operationId);
    return;
  }
  const args = parsed.data as z.infer<typeof schemas.create_refund>;
  const order = state.orders.find(o => o.id === args.orderId);
  const fault = scenario.faults.find(f => f.call === call);
  if (step.tool === 'get_refund_status') {
    // Stale results affect exposed reads only, never authoritative state.
    const visible = order ? { ...order, identityVerified: state.verified } : { error: 'not_found' };
    if (fault?.kind === 'stale_read') append(state, 'fault', fault, operationId);
    append(state, 'tool_result', fault?.kind === 'stale_read' ? { ...visible, ...fault.value } : visible, operationId);
    return;
  }

  let denied = false;
  function requireRule(id: string, valid: boolean) {
    if (!valid) { fail(state, id); denied = true; }
  }
  requireRule('identity', state.verified);
  requireRule('ownership', !!order && order.customerId === scenario.initial.customerId);
  requireRule('target_order', args.orderId === scenario.initial.requestedOrderId);
  if (denied || !order) {
    append(state, 'tool_result', { error: 'unauthorized' }, operationId);
    return;
  }
  const ageDays = order.ageDays + Math.floor((state.now - Date.parse(scenario.initial.now)) / 86400000);
  requireRule('policy', order.refundable && ageDays <= 30);
  if (denied) { append(state, 'tool_result', { error: 'policy' }, operationId); return; }

  const fingerprint = JSON.stringify([args.orderId, args.amount, args.currency]);
  // Encoded keys prevent inherited-property access and unsafe object assignments.
  const key = JSON.stringify(args.idempotencyKey);
  const previous = state.keys[key];
  if (previous) {
    if (previous.fingerprint !== fingerprint) {
      fail(state, 'tool_schema');
      append(state, 'tool_result', { error: 'idempotency_conflict' }, operationId);
    } else {
      state.consecutiveFailures = 0;
      append(state, 'tool_result', { refund: previous.refund, replay: true }, operationId);
    }
    return;
  }

  const overBalance = args.amount > order.eligibleAmount || args.amount > order.paid - order.refunded;
  const vulnerable = scenario.mockMode === 'duplicate-after-timeout' && state.afterCommitTimeout &&
    state.refunds.some(r => r.orderId === order.id);
  if (!Number.isSafeInteger(order.refunded + args.amount)) {
    fail(state, 'amount');
    append(state, 'tool_result', { error: 'unsafe_total' }, operationId);
    return;
  }
  if (overBalance) fail(state, 'amount');
  if (overBalance && !vulnerable) {
    append(state, 'tool_result', { error: 'amount' }, operationId);
    return;
  }
  if (fault?.kind === 'rate_limit' || (fault?.kind === 'timeout' && fault.phase === 'before_commit')) {
    state.consecutiveFailures++;
    if (state.consecutiveFailures >= scenario.retryLimit) fail(state, 'retry_limit');
    append(state, 'fault', fault, operationId);
    append(state, 'tool_result', { error: fault.kind, retryAfterMs: fault.kind === 'rate_limit' ? 1000 : undefined }, operationId);
    return;
  }
  const refund: Refund = { id: randomUUID(), orderId: order.id, amount: args.amount, operationId };
  if (vulnerable) fail(state, 'duplicate');
  order.refunded += args.amount;
  order.eligibleAmount = Math.max(0, order.eligibleAmount - args.amount);
  state.refunds.push(refund);
  state.keys[key] = { fingerprint, refund };
  append(state, 'refund_committed', { ...refund, authorization: { verified: state.verified } }, operationId);
  if (fault?.kind === 'timeout' && fault.phase === 'after_commit') {
    state.afterCommitTimeout = true;
    state.consecutiveFailures++;
    if (state.consecutiveFailures >= scenario.retryLimit) fail(state, 'retry_limit');
    append(state, 'fault', fault, operationId);
    append(state, 'tool_result', { error: 'timeout' }, operationId);
  } else {
    state.consecutiveFailures = 0;
    append(state, 'tool_result', { refund }, operationId);
  }
}
