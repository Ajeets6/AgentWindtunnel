import type { RunResult, Scenario, Event, Check } from './scenario.ts';

export type SuiteConfig = {
  scenarioPack: 'refunds-v1'; agentId: 'fixture-safe'; repeats: number;
  scenarioIds?: string[]; fixtureJudges: boolean;
};
export type Suite = {
  id: string; ownerId: string; createdAt: string; updatedAt: string;
  status: 'queued' | 'running' | 'completed' | 'cancelled' | 'error';
  config: SuiteConfig; scenarios: Scenario[]; cancelRequested: boolean;
  executions: { id: string; scenarioId: string; repetition: number; status: 'running' | RunResult['status'] }[];
  total: number;
};
export type SuiteEvent = { id: number; type: 'progress'; data: { status: Suite['status']; completed: number; total: number; executionId?: string } };
export type ExecutionView = Suite['executions'][number] & {
  title: string; result?: RunResult; before: Scenario['initial'];
  after: { now: string; verified: boolean; orders: Scenario['initial']['orders'] };
  events: Event[]; checks: Check[]; messages: string[]; finalMessage: string;
};
export type SuiteDetail = Omit<Suite, 'executions'> & { executions: ExecutionView[] };
