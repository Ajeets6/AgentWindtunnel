/** Test-facing boundary. Adapters must invoke real application code, not implement it. */
export type Status = 'passed' | 'failed' | 'needs_review' | 'error' | 'cancelled';
export type Step = { tool: string; args: Record<string, unknown> };
export type Scenario = {
  id: string; family: string; title: string; version: number;
  policyVersion: string; retryLimit: number;
  mockMode: 'strict' | 'duplicate-after-timeout';
  guardStub: 'safe' | 'suspicious' | 'unavailable';
  initial: {
    now: string; verified: boolean; customerId: string; requestedOrderId: string;
    orders: { id: string; customerId: string; paid: number; refunded: number;
      ageDays: number; refundable: boolean; eligibleAmount: number }[];
  };
  messages: string[]; steps: Step[]; finalMessage: string;
  faults: { kind: string; call: number; phase?: string; value?: Record<string, unknown> }[];
  judgeStub: { label: string; calibrated: boolean };
  expected: { status: Status; refundsCreated: number; newRefundAmount: number;
    failedChecks: string[]; reviewChecks: string[]; touchedOrders: string[] };
};
export type RunResult = {
  status: Status; executionId: string;
  checks: { id: string; required: boolean; status: 'pass' | 'fail' | 'needs_review' | 'error' }[];
  refunds: { id: string; orderId: string; amount: number; operationId: string }[];
  events: { id: string; sequence: number; type: string; operationId?: string }[];
  outbound: string[];
};
export type DecisionInput = {
  provider: 'laya' | 'jev'; response?: unknown; error?: number | string;
  networkMode?: 'local' | 'hybrid'; calibrated?: boolean;
  evidence?: string; complete?: boolean; inputTokens?: number; contextLimit?: number;
  purpose?: 'message' | 'injection'; critical?: boolean;
  deterministicFailure?: boolean; cloudAllowed?: boolean;
};
export type DecisionResult = {
  status: 'accepted' | 'needs_review' | 'rejected'; route: string;
  runStatus?: Status; outbound: string[]; generatedTokens: number;
  label?: string; reason: string;
  request?: { url: string; body: Record<string, unknown> };
};
export type Attack = {
  id: string; surface: 'customer' | 'tool' | 'policy-import' | 'transcript' | 'scenario-import';
  payload: string; intent: string; malicious: boolean;
};
export type EndpointInput = {
  url: string; mode: 'local' | 'lan' | 'hybrid';
  approved: string[]; resolved: string[]; connectedAddress?: string;
  redirect?: string; model?: string;
};
export type HttpResponse = {
  status: number; headers: Record<string, string>; text: string;
  outbound: string[]; mutationCount: number;
};
export type Harness = {
  dispose(): Promise<void>;
  runner?: {
    run(scenario: Scenario): Promise<RunResult>;
    lifecycle(action: 'cancel' | 'recover-after-commit' | 'isolation' | 'turn-limit' | 'budget-race'): Promise<{
      status: Status; refundsCreated: number; callsAfterStop: number;
      isolated: boolean; reservedCost: number; budget: number; outbound: string[];
    }>;
  };
  decisions?: {
    evaluate(input: DecisionInput): Promise<DecisionResult>;
    cacheKeys(changes: Record<string, unknown>[]): Promise<string[]>;
    buildEvidence(input: Record<string, unknown>): Promise<Record<string, unknown>>;
    normalize(provider: 'laya' | 'jev', question: Record<string, unknown>, answer: unknown): Promise<{
      type: string; label?: string; value?: number; confidence?: number;
    }>;
  };
  security?: {
    exercise(input: { attack: Attack; provider: 'laya' | 'jev';
      detector: 'safe' | 'suspicious' | 'unavailable'; mode: 'workbench' | 'webapp' }): Promise<{
      hostMutations: number; secretsExposed: string[]; outbound: string[];
      rawPayload: string; trustedPolicyVersion: string; reviewRequired: boolean;
      guardCalls: number; arbitraryToolExecuted: boolean;
    }>;
  };
  egress?: { check(input: EndpointInput): Promise<{ allowed: boolean; outbound: string[] }> };
  api?: {
    request(input: { method: string; path: string; headers?: Record<string, string>;
      body?: unknown; session?: 'owner' | 'none' | 'other'; csrf?: boolean }): Promise<HttpResponse>;
  };
  web?: {
    inspectPayload(payload: string): Promise<{
      visibleText: string; dialogs: number; externalRequests: string[];
      executedScripts: number; unsafeLinks: number; keyboardAccessible: boolean;
    }>;
  };
};
