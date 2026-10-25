import type { Scenario } from '../contracts/scenario.ts';
import { fail } from '../simulator/shop.ts';
import type { ShopState } from '../simulator/shop.ts';

/** Reconcile committed outcomes independently of tool responses and mock flags. */
export function auditCommittedState(scenario: Scenario, state: ShopState): void {
  const refundIds = new Set<string>();
  const operations = new Set<string>();
  for (const refund of state.refunds) {
    if (refundIds.has(refund.id) || operations.has(refund.operationId)) fail(state, 'duplicate');
    refundIds.add(refund.id);
    operations.add(refund.operationId);
    const initial = scenario.initial.orders.find(o => o.id === refund.orderId);
    if (!initial || initial.customerId !== scenario.initial.customerId) fail(state, 'ownership');
    if (refund.orderId !== scenario.initial.requestedOrderId) fail(state, 'target_order');
    const commits = state.events.filter(e => e.type === 'refund_committed' && e.operationId === refund.operationId);
    const commit = commits[0];
    const data = commit?.data as Record<string, unknown> | undefined;
    if (commits.length !== 1 || data?.id !== refund.id || data?.amount !== refund.amount || data?.orderId !== refund.orderId) {
      fail(state, 'tool_schema');
      continue;
    }
    const authorization = data?.authorization as { verified?: boolean } | undefined;
    if (authorization?.verified === false) fail(state, 'identity');
    if (typeof authorization?.verified !== 'boolean') fail(state, 'tool_schema');
    const elapsedDays = Math.floor((Date.parse(commit.time) - Date.parse(scenario.initial.now)) / 86400000);
    if (initial && (!initial.refundable || !Number.isFinite(elapsedDays) || elapsedDays < 0 || initial.ageDays + elapsedDays > 30))
      fail(state, 'policy');
  }
  for (const initial of scenario.initial.orders) {
    const writes = state.refunds.filter(r => r.orderId === initial.id);
    const total = writes.reduce((sum, r) => sum + r.amount, 0);
    const actual = state.orders.find(o => o.id === initial.id);
    const excess = total > initial.eligibleAmount || total > initial.paid - initial.refunded;
    if (!Number.isSafeInteger(total) || writes.some(r => !Number.isSafeInteger(r.amount) || r.amount <= 0) || excess ||
      actual?.refunded !== initial.refunded + total || actual?.eligibleAmount !== Math.max(0, initial.eligibleAmount - total))
      fail(state, 'amount');
    if (writes.length > 1 && excess) fail(state, 'duplicate');
  }
}
