import { z } from 'zod';

const cents = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const text = z.string().min(1).max(4096);
const order = z.strictObject({
  id: text, customerId: text, paid: cents, refunded: cents,
  ageDays: cents, refundable: z.boolean(), eligibleAmount: cents,
}).refine(o => o.refunded <= o.paid && o.eligibleAmount <= o.paid - o.refunded,
  'Order balances must agree');

/** Tool arguments stay unknown until the simulator validates the selected tool. */
export const scenarioSchema = z.strictObject({
  id: text, title: text, family: text, version: z.number().int().positive(),
  policyVersion: z.literal('p1'), retryLimit: z.number().int().min(1).max(10),
  mockMode: z.enum(['strict', 'duplicate-after-timeout']),
  guardStub: z.enum(['safe', 'suspicious', 'unavailable']),
  initial: z.strictObject({
    now: z.iso.datetime(), verified: z.boolean(), customerId: text,
    requestedOrderId: text, orders: z.array(order).min(1).max(1000),
  }).superRefine((state, ctx) => {
    if (new Set(state.orders.map(o => o.id)).size !== state.orders.length)
      ctx.addIssue({ code: 'custom', message: 'Duplicate order IDs' });
    if (!state.orders.some(o => o.id === state.requestedOrderId))
      ctx.addIssue({ code: 'custom', message: 'Requested order missing' });
  }),
  messages: z.array(z.string().max(65536)).min(1).max(100),
  steps: z.array(z.strictObject({ tool: text, args: z.record(z.string(), z.unknown()) })).max(1000),
  finalMessage: z.string().max(65536),
  faults: z.array(z.strictObject({
    kind: z.enum(['timeout', 'rate_limit', 'stale_read']),
    call: z.number().int().positive(),
    phase: z.enum(['before_commit', 'after_commit']).optional(),
    value: z.record(z.string(), z.unknown()).optional(),
  })).max(1000),
  judgeStub: z.strictObject({
    label: z.enum(['consistent', 'contradiction', 'insufficient_evidence']), calibrated: z.boolean(),
  }),
}).superRefine((s, ctx) => {
  const seen = new Set<number>();
  for (const fault of s.faults) {
    if (seen.has(fault.call) || fault.call > s.steps.length ||
      (fault.kind === 'timeout' && !fault.phase) ||
      (fault.kind === 'stale_read' && (!fault.value || s.steps[fault.call - 1]?.tool !== 'get_refund_status')) ||
      (fault.kind !== 'stale_read' && s.steps[fault.call - 1]?.tool !== 'create_refund'))
      ctx.addIssue({ code: 'custom', message: 'Invalid or conflicting fault schedule' });
    seen.add(fault.call);
  }
});

export type Scenario = z.infer<typeof scenarioSchema>;
export type Step = Scenario['steps'][number];
export type CheckStatus = 'pass' | 'fail' | 'needs_review' | 'error';
export type Status = 'passed' | 'failed' | 'needs_review' | 'error' | 'cancelled';
export type Check = { id: string; required: boolean; status: CheckStatus };
export type Refund = { id: string; orderId: string; amount: number; operationId: string };
export type Event = {
  id: string; sequence: number; type: string; operationId?: string;
  time: string; data: unknown;
};
export type RunResult = {
  status: Status; executionId: string; checks: Check[];
  refunds: Refund[]; events: Event[]; outbound: string[];
};

/** Oracle metadata is excluded before execution; no outcome is read from it. */
export function parseScenario(input: unknown): Scenario {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('Scenario must be an object');
  const { expected: _oracle, ...configuration } = input as Record<string, unknown>;
  rejectPrototypeKeys(configuration);
  return scenarioSchema.parse(configuration);
}

function rejectPrototypeKeys(value: unknown, depth = 0): void {
  if (depth > 32) throw new Error('Scenario nesting limit exceeded');
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('Forbidden scenario key');
      rejectPrototypeKeys(item, depth + 1);
    }
  }
}
