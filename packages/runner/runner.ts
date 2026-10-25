import { randomUUID } from 'node:crypto';
import { parseScenario } from '../contracts/scenario.ts';
import type { RunResult, Status } from '../contracts/scenario.ts';
import { append, initialState, invoke } from '../simulator/shop.ts';
import { ExecutionStore } from './store.ts';
import type { Execution } from './store.ts';

export type Assessment = { label: 'consistent' | 'contradiction' | 'insufficient_evidence'; calibrated: boolean };
export type Evidence = {
  agentMessage: string; customerMessages: string[];
  verifiedOutcome: { verified: boolean; refunds: RunResult['refunds'] };
  eventIds: string[];
};
export type RunOptions = {
  signal?: AbortSignal; maxSteps?: number;
  judgmentSource?: RunResult['judgmentSource'];
  judge?: (evidence: Evidence) => Promise<Assessment>;
  guard?: () => Promise<'safe' | 'suspicious' | 'unavailable'>;
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
    execution.judgmentSource = options.judgmentSource ?? (options.judge ? 'injected-provider' : 'unverified-review');
    const maxSteps = options.maxSteps ?? 128;
    if (!Number.isSafeInteger(maxSteps) || maxSteps < 1 || maxSteps > 1000) throw new Error('Invalid step limit');
    const verificationCode = randomUUID();
    const { state, scenario } = execution;
    while (execution.cursor < scenario.steps.length) {
      if (options.signal?.aborted) return this.finish(execution, 'cancelled');
      if (execution.cursor >= maxSteps) return this.finish(execution, 'error');
      if (state.checks.find(c => c.id === 'retry_limit')?.status === 'fail') break;
      invoke(state, scenario, scenario.steps[execution.cursor], execution.cursor + 1, verificationCode);
      execution.cursor++;
      // A possibly committed write is never replayed: its cursor shares this checkpoint.
      this.store.save(execution);
      await options.onCheckpoint?.(structuredClone(execution));
    }
    if (options.signal?.aborted) return this.finish(execution, 'cancelled');
    append(state, 'agent_message', { text: scenario.finalMessage });
    let guard: 'safe' | 'suspicious' | 'unavailable' = 'unavailable';
    let assessment: Assessment = { label: 'insufficient_evidence', calibrated: false };
    try { guard = await options.guard?.() ?? 'unavailable'; } catch { /* Unavailable stays unresolved. */ }
    if (options.signal?.aborted) return this.finish(execution, 'cancelled');
    if (guard === 'safe') {
      try {
        assessment = await options.judge?.({
          agentMessage: scenario.finalMessage, customerMessages: structuredClone(scenario.messages),
          verifiedOutcome: { verified: state.verified, refunds: structuredClone(state.refunds) },
          eventIds: state.events.map(e => e.id),
        }) ?? assessment;
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
