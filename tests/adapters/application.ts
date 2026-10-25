import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExecutionStore } from '../../packages/runner/store.ts';
import { Runner } from '../../packages/runner/runner.ts';
import { Budget } from '../../packages/runner/budget.ts';
import { scenarios } from '../support/fixtures.ts';
import type { Harness, Scenario } from '../support/contracts.ts';

function fixtureOptions(scenario: Scenario) {
  return {
    guard: async () => scenario.guardStub,
    judge: async () => ({ ...scenario.judgeStub, label: scenario.judgeStub.label as 'consistent' | 'contradiction' | 'insufficient_evidence' }),
  };
}

export async function createHarness(): Promise<Harness> {
  let directory: string | undefined;
  let store: ExecutionStore | undefined;
  async function setup() {
    directory ??= await mkdtemp(join(tmpdir(), 'aw-runner-'));
    store ??= new ExecutionStore(join(directory, 'executions.sqlite'));
    return new Runner(store);
  }
  return {
    runner: {
      async run(scenario) {
        return (await setup()).run(scenario, fixtureOptions(scenario));
      },
      async lifecycle(action) {
        let runner = await setup();
        const scenario = structuredClone(scenarios.find(s => s.id === 'RF-017')!);
        const options = fixtureOptions(scenario);
        const controller = new AbortController();
        let callsAfterStop = 0;
        let stopped = false;
        let isolated = false;
        let reservedCost = 0;
        const budget = new Budget(100);
        if (action === 'budget-race') {
          await Promise.all(Array.from({ length: 12 }, async (_, i) => {
            await Promise.resolve();
            budget.reserve(`call-${i}`, 30);
          }));
          reservedCost = budget.reserved;
        }
        const result = await runner.run(scenario, {
          ...options, signal: controller.signal, maxSteps: action === 'turn-limit' ? 1 : 128,
          onCheckpoint(execution) {
            if (stopped) callsAfterStop++;
            if (action === 'cancel') { controller.abort(); stopped = true; }
            if (action === 'turn-limit' && execution.cursor === 1) stopped = true;
          },
        });
        let refundsCreated = result.refunds.length;
        if (action === 'recover-after-commit') {
          const id = runner.start(scenario);
          await runner.resume(id, { ...options, onCheckpoint() { throw new Error('simulated-worker-crash'); } })
            .then(() => { throw new Error('Crash hook was not reached'); }, error => {
              if (error.message !== 'simulated-worker-crash') throw error;
            });
          store!.close();
          store = new ExecutionStore(join(directory!, 'executions.sqlite'));
          runner = new Runner(store);
          refundsCreated = (await runner.resume(id, options)).refunds.length;
        }
        if (action === 'isolation') {
          const second = await runner.run(scenario, options);
          isolated = result.executionId !== second.executionId && second.refunds.length === 1 &&
            result.refunds.every(r => !second.refunds.some(other => r.id === other.id));
        }
        return { status: result.status, refundsCreated, callsAfterStop, isolated,
          reservedCost, budget: budget.limit, outbound: result.outbound };
      },
    },
    async dispose() {
      store?.close();
      if (directory) await rm(directory, { recursive: true, force: true });
    },
  };
}
