import { randomUUID } from 'node:crypto';
import { setImmediate as yieldWorker } from 'node:timers/promises';
import { EventEmitter } from 'node:events';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Runner } from '../../packages/runner/runner.ts';
import { ExecutionStore } from '../../packages/runner/store.ts';
import { SuiteStore } from './store.ts';
import { redact } from './security.ts';
import type { Scenario } from '../../packages/contracts/scenario.ts';
import type { Suite, SuiteConfig } from '../../packages/contracts/api.ts';

export class Workbench {
  readonly suites: SuiteStore;
  readonly executions: ExecutionStore;
  readonly catalog: Scenario[];
  readonly events = new EventEmitter();
  readonly secrets: string[];
  private runner: Runner;
  private worker?: Promise<void>;
  private controllers = new Map<string, AbortController>();
  private stopping = false;
  private mutationCounter = 0;

  private constructor(path: string, catalog: Scenario[], secrets: string[]) {
    this.suites = new SuiteStore(path);
    this.executions = new ExecutionStore(path);
    this.runner = new Runner(this.executions);
    this.catalog = redact(structuredClone(catalog), secrets);
    this.secrets = secrets;
  }
  static async open(path: string, catalog: Scenario[], secrets: string[] = []) {
    await mkdir(dirname(path), { recursive: true });
    return new Workbench(path, catalog, secrets);
  }
  get mutations() { return this.mutationCounter; }
  private save(suite: Suite, executionId?: string): void {
    const event = this.suites.save(redact(suite, this.secrets), executionId);
    this.mutationCounter++;
    this.events.emit(suite.id, event);
  }
  enqueue(ownerId: string, config: SuiteConfig): Suite {
    if (this.suites.list(ownerId).filter(s => ['queued', 'running'].includes(s.status)).length >= 8)
      throw Object.assign(new Error('Queue is full'), { statusCode: 429 });
    const scenarios = this.catalog.filter(s => !config.scenarioIds || config.scenarioIds.includes(s.id));
    if (!scenarios.length || (config.scenarioIds && scenarios.length !== config.scenarioIds.length) || scenarios.length * config.repeats > 400)
      throw Object.assign(new Error('Invalid scenario selection or suite size'), { statusCode: 400 });
    const suite: Suite = { id: randomUUID(), ownerId, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      status: 'queued', config, scenarios: structuredClone(scenarios), executions: [], total: scenarios.length * config.repeats,
      cancelRequested: false };
    this.save(suite);
    this.kick();
    return suite;
  }
  cancel(id: string, ownerId: string): boolean {
    const suite = this.suites.get(id, ownerId);
    if (!suite) return false;
    if (suite.status === 'queued' || suite.status === 'running') {
      suite.cancelRequested = true;
      this.save(suite);
      this.controllers.get(id)?.abort();
      this.kick();
    }
    return true;
  }
  kick(): void {
    if (this.stopping || this.worker) return;
    this.worker = (async () => {
      await yieldWorker();
      while (!this.stopping) {
        const next = this.suites.list().reverse().find(s => s.status === 'queued' || s.status === 'running');
        if (!next) break;
        await this.execute(next);
      }
    })().finally(() => { this.worker = undefined; });
  }
  async idle(): Promise<void> { await this.worker; }
  private async execute(suite: Suite): Promise<void> {
    const controller = new AbortController();
    this.controllers.set(suite.id, controller);
    suite.status = 'running';
    this.save(suite);
    try {
      outer: for (const scenario of suite.scenarios) for (let repetition = 1; repetition <= suite.config.repeats; repetition++) {
        const latest = this.suites.get(suite.id, suite.ownerId)!;
        if (latest.cancelRequested) controller.abort();
        if (this.stopping) break outer;
        if (controller.signal.aborted) { suite.cancelRequested = true; suite.status = 'cancelled'; break outer; }
        let item = suite.executions.find(e => e.scenarioId === scenario.id && e.repetition === repetition);
        if (item && item.status !== 'running') continue;
        if (!item) {
          item = { id: this.runner.start(scenario), scenarioId: scenario.id, repetition, status: 'running' };
          suite.executions.push(item);
          this.save(suite, item.id);
        }
        const result = await this.runner.resume(item.id, {
          signal: controller.signal,
          ...(suite.config.fixtureJudges ? { judgmentSource: 'fixture-stubs' as const,
            guard: async () => scenario.guardStub, judge: async () => scenario.judgeStub } : {}),
          onCheckpoint: async () => {
            await yieldWorker();
            if (this.suites.get(suite.id, suite.ownerId)?.cancelRequested) controller.abort();
          },
        });
        item.status = result.status;
        this.save(suite, item.id);
        await yieldWorker();
      }
      if (!this.stopping && suite.status === 'running') suite.status = 'completed';
      if (controller.signal.aborted && !this.stopping) { suite.status = 'cancelled'; suite.cancelRequested = true; }
    } catch {
      suite.status = 'error';
    } finally {
      this.controllers.delete(suite.id);
      this.save(suite);
    }
  }
  details(id: string, ownerId: string) {
    const suite = this.suites.get(id, ownerId);
    if (!suite) return undefined;
    return redact({ ...suite, executions: suite.executions.map(item => {
      const execution = this.executions.load(item.id);
      return { ...item, title: execution.scenario.title, result: execution.result,
        before: execution.scenario.initial,
        after: { now: new Date(execution.state.now).toISOString(), verified: execution.state.verified, orders: execution.state.orders },
        events: execution.state.events, checks: execution.state.checks,
        messages: execution.scenario.messages, finalMessage: execution.scenario.finalMessage };
    }) }, this.secrets);
  }
  async close(): Promise<void> {
    this.stopping = true;
    // Let the current scripted execution finish its checkpoint before shutdown.
    await this.worker;
    this.events.removeAllListeners();
    this.executions.close();
    this.suites.close();
  }
}
