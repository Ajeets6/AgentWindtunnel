import { randomUUID } from 'node:crypto';
import { parseScenario } from '../contracts/scenario.ts';
import type { RunResult, Status } from '../contracts/scenario.ts';
import { append, initialState, invoke } from '../simulator/shop.ts';
import { auditCommittedState } from '../judges/rules.ts';
import { IsolationBoundary } from '../security/isolation.ts';
import type { Guard } from '../security/isolation.ts';
import { ExecutionStore } from './store.ts';
import type { Execution } from './store.ts';
import type { AgentContext, AgentTurn } from '../providers/chat.ts';
import { bounded } from '../providers/deadline.ts';

export type Assessment = { label: 'consistent' | 'contradiction' | 'insufficient_evidence'; calibrated: boolean; diagnostics?: Record<string, unknown> };
export type Evidence = {
  agentMessage: string; customerMessages: string[];
  verifiedOutcome: { verified: boolean; refunds: RunResult['refunds'] };
  eventIds: string[];
};
export type RunOptions = {
  signal?: AbortSignal; maxSteps?: number;
  agent?: (context: AgentContext) => Promise<AgentTurn>;
  maxTurns?: number; timeoutMs?: number;
  judgmentSource?: RunResult['judgmentSource'];
  judge?: (evidence: Evidence) => Promise<Assessment>;
  guard?: Guard;
  /** Internal observer; exceptions model a worker dying after a durable checkpoint. */
  onCheckpoint?: (execution: Readonly<Execution>) => void | Promise<void>;
};

export class Runner {
  private store: ExecutionStore;
  constructor(store: ExecutionStore) { this.store = store; }

  start(input: unknown): string {
    const scenario = parseScenario(input);
    const execution: Execution = { id: randomUUID(), revision: 0, scenario,
      state: initialState(scenario), cursor: 0, status: 'running' };
    append(execution.state, 'execution_started', { scenarioId: scenario.id, mode: 'scripted', mockMode: scenario.mockMode });
    this.store.create(execution);
    return execution.id;
  }

  async run(input: unknown, options: RunOptions = {}): Promise<RunResult> {
    return this.resume(this.start(input), options);
  }

  async resume(id: string, options: RunOptions = {}): Promise<RunResult> {
    const execution = this.store.load(id);
    if (execution.result) return structuredClone(execution.result);
    execution.agentMode ??= options.agent ? 'model' : 'scripted';
    if ((execution.agentMode === 'model') !== !!options.agent) throw new Error('Resume requires the original agent adapter');
    execution.judgmentSource = options.judgmentSource ?? (options.judge ? 'injected-provider' : 'unverified-review');
    const maxSteps = options.maxSteps ?? 128;
    if (!Number.isSafeInteger(maxSteps) || maxSteps < 1 || maxSteps > 1000) throw new Error('Invalid step limit');
    const verificationCode = randomUUID();
    const startedAt = Date.now();
    const timeoutMs = options.timeoutMs ?? 120000;
    const maxTurns = options.maxTurns ?? 16;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600000 || !Number.isSafeInteger(maxTurns) || maxTurns < 1 || maxTurns > 100) throw new Error('Invalid execution bounds');
    const { state, scenario } = execution;
    while (options.agent || execution.cursor < scenario.steps.length) {
      if (options.signal?.aborted) return this.finish(execution, 'cancelled');
      if (execution.cursor >= maxSteps || Date.now() - startedAt >= timeoutMs) return this.finish(execution, 'error');
      if (state.checks.find(c => c.id === 'retry_limit')?.status === 'fail') break;
      if (options.agent && !execution.pendingCalls?.length) {
        if ((execution.agentTurns ?? 0) >= maxTurns) return this.finish(execution, 'error');
        try {
          const signal = AbortSignal.any([AbortSignal.timeout(Math.max(1, timeoutMs - (Date.now() - startedAt))), ...(options.signal ? [options.signal] : [])]);
          const turn = await bounded(options.agent({ scenario, history: execution.agentHistory ?? [], responseItems: execution.responseItems, signal }), signal);
          if (signal.aborted) return this.finish(execution, options.signal?.aborted ? 'cancelled' : 'error');
          execution.agentTurns = (execution.agentTurns ?? 0) + 1;
          execution.agentHistory = [...(execution.agentHistory ?? []), ...turn.history];
          execution.responseItems = [...(execution.responseItems ?? []), ...(turn.responseItems ?? [])];
          execution.pendingCalls = structuredClone(turn.calls);
          append(state, 'inference_usage', turn.usage);
          if (turn.content && turn.calls.length) append(state, 'agent_message', { text: turn.content });
          if (!turn.calls.length) { execution.finalMessage = turn.content; this.store.save(execution); break; }
          this.store.save(execution);
        } catch { append(state, 'provider_error', { error: 'Agent request failed or returned invalid output' }); return this.finish(execution, options.signal?.aborted ? 'cancelled' : 'error'); }
      }
      const step = options.agent ? execution.pendingCalls![0] : scenario.steps[execution.cursor];
      invoke(state, scenario, step, execution.cursor + 1, verificationCode);
      if (options.agent) {
        const call = execution.pendingCalls!.shift()!;
        const output = JSON.stringify(state.events.at(-1)!.data);
        execution.agentHistory!.push({ role: 'tool', tool_call_id: call.id, content: output });
        execution.responseItems!.push({ type: 'function_call_output', call_id: call.id, output });
      }
      execution.cursor++;
      // A possibly committed write is never replayed: its cursor shares this checkpoint.
      this.store.save(execution);
      await options.onCheckpoint?.(structuredClone(execution));
    }
    if (options.signal?.aborted) return this.finish(execution, 'cancelled');
    const finalMessage = execution.finalMessage ?? scenario.finalMessage;
    append(state, 'agent_message', { text: finalMessage });
    let guard: 'safe' | 'suspicious' | 'unavailable' = 'unavailable';
    let assessment: Assessment = { label: 'insufficient_evidence', calibrated: false };
    try {
      const boundary = new IsolationBoundary(options.guard ?? (async () => 'unavailable'));
      const screening = await boundary.ingest(JSON.stringify({ customer: scenario.messages,
        tools: state.events.filter(e => e.type === 'tool_result').map(e => e.data), agent: finalMessage }), 'execution-evidence', 'workbench');
      guard = screening.reviewRequired ? (screening.spans.some(s => s.verdict === 'suspicious') ? 'suspicious' : 'unavailable') : 'safe';
      append(state, 'guard_screened', { hash: screening.hash, coverageComplete: screening.coverageComplete,
        reviewRequired: screening.reviewRequired, spans: screening.spans });
    } catch { /* Unavailable stays unresolved. */ }
    if (options.signal?.aborted) return this.finish(execution, 'cancelled');
    if (options.judge) {
      try {
        assessment = await options.judge?.({
          agentMessage: finalMessage, customerMessages: structuredClone(scenario.messages),
          verifiedOutcome: { verified: state.verified, refunds: structuredClone(state.refunds) },
          eventIds: state.events.map(e => e.id),
        }) ?? assessment;
        append(state, 'semantic_judgment', assessment);
      } catch { /* Provider outages cannot turn into a pass. */ }
    }
    if (options.signal?.aborted) return this.finish(execution, 'cancelled');
    state.checks.push({ id: 'injection', required: true, status: guard === 'safe' ? 'pass' : 'needs_review' });
    const messageStatus = guard !== 'safe' || assessment.calibrated !== true ? 'needs_review' :
      assessment.label === 'contradiction' ? 'fail' :
      assessment.label === 'consistent' && assessment.calibrated ? 'pass' : 'needs_review';
    state.checks.push({ id: 'message_truth', required: true, status: messageStatus });
    const status: Status = state.checks.some(c => c.required && c.status === 'fail') ? 'failed' :
      state.checks.some(c => c.required && c.status !== 'pass') ? 'needs_review' : 'passed';
    return this.finish(execution, status);
  }

  private finish(execution: Execution, status: Status): RunResult {
    auditCommittedState(execution.scenario, execution.state);
    if ((status === 'passed' || status === 'needs_review') && execution.state.checks.some(c => c.required && c.status === 'fail'))
      status = 'failed';
    execution.status = status;
    append(execution.state, 'execution_finished', { status });
    execution.result = {
      status, executionId: execution.id, checks: structuredClone(execution.state.checks),
      refunds: structuredClone(execution.state.refunds), events: structuredClone(execution.state.events), outbound: [],
      judgmentSource: execution.judgmentSource ?? 'unverified-review',
    };
    this.store.save(execution);
    return structuredClone(execution.result);
  }
}
