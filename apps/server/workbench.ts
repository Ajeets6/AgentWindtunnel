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
import { parseScenario } from '../../packages/contracts/scenario.ts';
import type { ProviderConfig, Review } from '../../packages/contracts/providers.ts';
import { providerSchema } from '../../packages/contracts/providers.ts';
import { decisionClient } from '../../packages/providers/runtime.ts';
import { providerTransport } from '../../packages/providers/runtime.ts';
import { ChatAgent } from '../../packages/providers/chat.ts';
import type { Status } from '../../packages/contracts/scenario.ts';
import { agentSchema, type AgentProfile } from '../../packages/contracts/agent.ts';

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
  scenarios(ownerId: string): Scenario[] { return [...this.catalog, ...this.suites.documents<Scenario>(ownerId, 'scenario')]; }
  duplicateScenario(ownerId: string, sourceId: string, edits: { title: string; messages: string[]; finalMessage: string } & Partial<Pick<Scenario, 'steps' | 'initial' | 'faults' | 'retryLimit' | 'mockMode'>>): Scenario {
    const source = this.scenarios(ownerId).find(s => s.id === sourceId);
    if (!source) throw Object.assign(new Error('Not found'), { statusCode: 404 });
    let scenario: Scenario;
    try { scenario = parseScenario({ ...source, ...edits, id: 'SC-' + randomUUID(), version: source.version + 1 }); }
    catch { throw Object.assign(new Error('Invalid scenario data or fault schedule'), { statusCode: 400 }); }
    this.suites.put(ownerId, 'scenario', scenario.id, redact(scenario, this.secrets));
    this.mutationCounter++;
    return scenario;
  }
  providers(ownerId: string): ProviderConfig[] { return this.suites.documents(ownerId, 'provider'); }
  agents(ownerId: string): AgentProfile[] { return this.suites.documents(ownerId, 'agent'); }
  configureAgent(ownerId: string, input: unknown): AgentProfile {
    const profile = agentSchema.parse(input);
    if (!this.providers(ownerId).some(p => p.id === profile.providerId && p.roles.includes('agent')))
      throw Object.assign(new Error('Agent provider unavailable'), { statusCode: 400 });
    if (this.providers(ownerId).some(p => p.id === profile.id) || profile.id === 'fixture-safe')
      throw Object.assign(new Error('Agent ID collides with provider or fixture'), { statusCode: 400 });
    this.suites.put(ownerId, 'agent', profile.id, profile);
    this.mutationCounter++; return profile;
  }
  configureProvider(ownerId: string, input: unknown): ProviderConfig {
    const config = providerSchema.parse(input);
    if (config.id === 'fixture-safe' || this.agents(ownerId).some(agent => agent.id === config.id))
      throw Object.assign(new Error('Provider ID collides with agent or fixture'), { statusCode: 400 });
    this.suites.put(ownerId, 'provider', config.id, config);
    this.mutationCounter++; return config;
  }
  review(ownerId: string, executionId: string, input: Pick<Review, 'checkId' | 'status' | 'note'>): Review {
    const suite = this.suites.list(ownerId).find(s => s.executions.some(e => e.id === executionId));
    if (!suite) throw Object.assign(new Error('Not found'), { statusCode: 404 });
    const execution = this.executions.load(executionId);
    if (!execution.result || !['message_truth', 'injection'].includes(input.checkId)) throw Object.assign(new Error('Not reviewable'), { statusCode: 400 });
    const review: Review = { ...input, id: randomUUID(), executionId, reviewer: ownerId, createdAt: new Date().toISOString() };
    this.suites.put(ownerId, 'review', review.id, redact(review, this.secrets));
    this.mutationCounter++; return review;
  }
  calibration(ownerId: string) {
    const reviews = this.suites.documents<Review>(ownerId, 'review');
    const matrix: Record<string, number> = {};
    const latest = new Map(reviews.map(review => [`${review.executionId}:${review.checkId}`, review]));
    for (const review of latest.values()) {
      const execution = this.executions.load(review.executionId);
      const original = execution.result?.checks.find(c => c.id === review.checkId)?.status ?? 'missing';
      const semantic = execution.state.events.filter(e => e.type === 'semantic_judgment').at(-1)?.data as { label?: string; diagnostics?: { provider?: string; modelRevision?: string } } | undefined;
      const prediction = review.checkId === 'message_truth' ? semantic?.label ?? original : original;
      const key = `${semantic?.diagnostics?.provider ?? execution.result?.judgmentSource ?? 'unknown'}:${semantic?.diagnostics?.modelRevision ?? 'fixture'}:${review.checkId}:v1:${prediction}->${review.status}`;
      matrix[key] = (matrix[key] ?? 0) + 1;
    }
    return { reviewed: reviews.length, uniqueAdjudications: latest.size, matrix, automaticAcceptanceEnabled: false, caveat: 'Latest operational labels per execution/check; not a held-out accuracy benchmark.' };
  }
  private save(suite: Suite, executionId?: string): void {
    suite.cancelRequested ||= this.suites.get(suite.id, suite.ownerId)?.cancelRequested ?? false;
    const event = this.suites.save(redact(suite, this.secrets), executionId);
    this.mutationCounter++;
    this.events.emit(suite.id, event);
  }
  enqueue(ownerId: string, config: SuiteConfig): Suite {
    if (this.suites.list(ownerId).filter(s => ['queued', 'running'].includes(s.status)).length >= 8)
      throw Object.assign(new Error('Queue is full'), { statusCode: 429 });
    const scenarios = this.scenarios(ownerId).filter(s => !config.scenarioIds || config.scenarioIds.includes(s.id));
    if (!scenarios.length || (config.scenarioIds && scenarios.length !== config.scenarioIds.length) || scenarios.length * config.repeats > 400)
      throw Object.assign(new Error('Invalid scenario selection or suite size'), { statusCode: 400 });
    const suite: Suite = { id: randomUUID(), ownerId, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      status: 'queued', config, scenarios: structuredClone(scenarios), executions: [], total: scenarios.length * config.repeats,
      cancelRequested: false, providers: structuredClone(this.providers(ownerId)) };
    const profile = this.agents(ownerId).find(a => a.id === config.agentId);
    if (profile && !profile.enabled) throw Object.assign(new Error('Agent disabled'), { statusCode: 400 });
    suite.agentProfile = profile && structuredClone(profile);
    if (config.defenseMode === 'enforce' && (!config.guardProviderId || config.fixtureJudges))
      throw Object.assign(new Error('Enforcement requires a real guard provider'), { statusCode: 400 });
    for (const [id, role] of [[config.agentId === 'fixture-safe' ? undefined : profile?.providerId ?? config.agentId, 'agent'], [config.judgeProviderId, 'judge'], [config.guardProviderId, 'injection-guard']] as const)
      if (id && !suite.providers!.some(p => p.id === id && p.enabled && p.roles.includes(role))) throw Object.assign(new Error('Provider or role unavailable'), { statusCode: 400 });
    if (config.baselineId && !this.suites.get(config.baselineId, ownerId)) throw Object.assign(new Error('Baseline not found'), { statusCode: 404 });
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
          defenseMode: suite.config.defenseMode ?? 'observe',
          ...(suite.agentProfile ? { allowedTools: suite.agentProfile.tools, maxTurns: suite.agentProfile.maxTurns } : {}),
          ...(suite.config.agentId !== 'fixture-safe' ? {
            agent: async context => {
              const provider = suite.providers!.find(p => p.id === (suite.agentProfile?.providerId ?? suite.config.agentId))!;
              const client = new ChatAgent(provider, providerTransport(provider, this.suites,
                { suiteId: suite.id, budgetMicros: suite.config.cloudBudgetMicros ?? 0, ownerId: suite.ownerId, role: 'agent' }, this.secrets), suite.agentProfile);
              if (provider.networkMode !== 'hybrid') {
                const health = await client.health(controller.signal);
                if (provider.protocol === 'ollama' && provider.modelRevision === provider.model) {
                  provider.modelRevision = health.revision;
                  this.save(suite, item!.id);
                }
              }
              return client.next(context);
            },
          } : {}),
          ...(suite.config.fixtureJudges ? { judgmentSource: 'fixture-stubs' as const,
            guard: async () => scenario.guardStub, judge: async () => scenario.judgeStub } : {}),
          ...(!suite.config.fixtureJudges && suite.config.judgeProviderId ? {
            judge: async evidence => {
              const provider = suite.providers!.find(p => p.id === suite.config.judgeProviderId)!;
              if (provider.protocol !== 'systemone') {
                const client = new ChatAgent(provider, providerTransport(provider, this.suites, { suiteId: suite.id, budgetMicros: suite.config.cloudBudgetMicros ?? 0, ownerId: suite.ownerId, role: 'judge' }, this.secrets));
                if (provider.networkMode !== 'hybrid') await client.health(controller.signal);
                return client.judge(evidence, controller.signal);
              }
              const client = decisionClient(provider, this.suites, suite.ownerId, { suiteId: suite.id, executionId: item!.id, budgetMicros: suite.config.cloudBudgetMicros ?? 0 }, this.secrets);
              const result = await client.evaluate({ evidence: JSON.stringify(evidence), complete: true, signal: controller.signal });
              return { label: result.label === 'consistent' || result.label === 'contradiction' ? result.label : 'insufficient_evidence' as const, calibrated: result.status === 'accepted',
                diagnostics: { provider: provider.id, modelRevision: provider.modelRevision, reason: result.reason,
                  probabilities: result.probabilities, outputTokens: result.generatedTokens } };
            }, judgmentSource: 'injected-provider' as const,
          } : {}),
          ...(!suite.config.fixtureJudges && suite.config.guardProviderId ? {
            guard: async span => {
              const provider = suite.providers!.find(p => p.id === suite.config.guardProviderId)!;
              if (provider.protocol !== 'systemone') return 'unavailable' as const;
              return decisionClient(provider, this.suites, suite.ownerId, { suiteId: suite.id, executionId: item!.id, budgetMicros: suite.config.cloudBudgetMicros ?? 0, role: 'injection-guard' }, this.secrets)
                .screen(span.text, AbortSignal.any([controller.signal, ...(span.signal ? [span.signal] : [])]));
            },
          } : {}),
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
      for (const execution of suite.executions) if (execution.status === 'running') execution.status = 'error';
    } finally {
      this.controllers.delete(suite.id);
      this.save(suite);
    }
  }
  details(id: string, ownerId: string) {
    const suite = this.suites.get(id, ownerId);
    if (!suite) return undefined;
    return redact({ ...suite, spending: this.suites.spending(id), executions: suite.executions.map(item => {
      const execution = this.executions.load(item.id);
      const reviews = this.suites.documents<Review>(ownerId, 'review').filter(r => r.executionId === item.id);
      const effective = execution.state.checks.map(check => ({ ...check, status: reviews.filter(r => r.checkId === check.id).at(-1)?.status ?? check.status }));
      const adjudicatedStatus: Status | undefined = item.status === 'running' ? undefined : ['error', 'cancelled'].includes(item.status) ? item.status as Status :
        effective.some(c => c.required && c.status === 'fail') ? 'failed' : effective.some(c => c.required && c.status !== 'pass') ? 'needs_review' : 'passed';
      return { ...item, title: execution.scenario.title, result: execution.result,
        before: execution.scenario.initial,
        after: { now: new Date(execution.state.now).toISOString(), verified: execution.state.verified, orders: execution.state.orders },
        events: execution.state.events, checks: execution.state.checks,
        messages: execution.scenario.messages, finalMessage: execution.finalMessage ?? execution.scenario.finalMessage, reviews, adjudicatedStatus };
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
