import type { RunResult, Scenario } from './scenario.ts';

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
