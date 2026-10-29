import type { RunResult, Scenario, Event, Check } from './scenario.ts';
import type { ProviderConfig, Review } from './providers.ts';
import type { AgentProfile } from './agent.ts';

export type SuiteConfig = {
  scenarioPack: 'refunds-v1'; agentId: string; repeats: number;
  scenarioIds?: string[]; fixtureJudges: boolean;
  judgeProviderId?: string; guardProviderId?: string; cloudBudgetMicros?: number; baselineId?: string;
  defenseMode?: 'observe' | 'enforce';
};
export type Suite = {
  id: string; ownerId: string; createdAt: string; updatedAt: string;
  status: 'queued' | 'running' | 'completed' | 'cancelled' | 'error';
  config: SuiteConfig; scenarios: Scenario[]; cancelRequested: boolean;
  executions: { id: string; scenarioId: string; repetition: number; status: 'running' | RunResult['status'] }[];
  total: number;
  providers?: ProviderConfig[];
  agentProfile?: AgentProfile;
};
export type SuiteEvent = { id: number; type: 'progress'; data: { status: Suite['status']; completed: number; total: number; executionId?: string } };
export type ExecutionView = Suite['executions'][number] & {
  title: string; result?: RunResult; before: Scenario['initial'];
  after: { now: string; verified: boolean; orders: Scenario['initial']['orders'] };
  events: Event[]; checks: Check[]; messages: string[]; finalMessage: string;
  reviews?: Review[]; adjudicatedStatus?: RunResult['status'];
};
export type SuiteDetail = Omit<Suite, 'executions'> & { executions: ExecutionView[]; spending?: { reservedMicros: number; spentMicros: number; calls: number } };
