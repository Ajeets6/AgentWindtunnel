import { mkdtemp, rm, mkdir, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExecutionStore } from '../../packages/runner/store.ts';
import { Runner } from '../../packages/runner/runner.ts';
import { Budget } from '../../packages/runner/budget.ts';
import { scenarios } from '../support/fixtures.ts';
import type { Harness, Scenario } from '../support/contracts.ts';
import { Workbench } from '../../apps/server/workbench.ts';
import { buildApp } from '../../apps/server/app.ts';
import { parseScenario } from '../../packages/contracts/scenario.ts';
import { openBrowserWorkspace } from '../support/browser.ts';
import { approveEndpoint } from '../../packages/providers/egress.ts';
import { ControlledTransport } from '../../packages/providers/transport.ts';
import { SystemOneClient, buildEvidence, cacheKey, normalizeAnswer } from '../../packages/providers/systemone.ts';
import type { Question } from '../../packages/providers/systemone.ts';
import { IsolationBoundary } from '../../packages/security/isolation.ts';

function browserCapability(): Pick<Harness, 'web'> {
  return {
    web: {
      async inspectPayload(payload) {
        const scenario = parseScenario(scenarios.find(s => s.id === 'RF-001'));
        scenario.messages = [payload];
        scenario.finalMessage = payload;
        const workspace = await openBrowserWorkspace({ catalog: [scenario] });
        try {
          const { page, api, address } = workspace;
          let dialogs = 0;
          const externalRequests: string[] = [];
          page.on('dialog', dialog => { dialogs++; void dialog.dismiss(); });
          page.on('request', request => { if (!request.url().startsWith(address + '/')) externalRequests.push(request.url()); });
          await page.addInitScript(() => { (window as unknown as Record<string, unknown>).__awExecuted = false; });
          const suite = api.service.enqueue('local-owner', { scenarioPack: 'refunds-v1', agentId: 'fixture-safe', repeats: 1,
            scenarioIds: [scenario.id], fixtureJudges: false });
          await api.service.idle();
          await workspace.signIn();
          await page.getByRole('region', { name: 'Run inspector' }).waitFor();
          const visibleText = await page.locator('body').innerText();
          const executedScripts = await page.evaluate(() => (window as unknown as Record<string, unknown>).__awExecuted === true ? 1 : 0);
          const unsafeLinks = await page.locator('a[href^="javascript:"],a[href^="file:"],a[href^="data:"]').count();
          const runButton = page.getByRole('button', { name: 'Run suite', exact: true });
          await runButton.focus();
          await page.keyboard.press('Tab');
          const nextReached = await page.getByLabel('Use synthetic fixture judgments').evaluate(element => element === document.activeElement);
          await page.keyboard.press('Shift+Tab');
          const keyboardAccessible = nextReached && await runButton.evaluate(element => element === document.activeElement);
          if (api.service.details(suite.id, 'local-owner')!.executions[0].messages[0] !== payload)
            throw new Error('Stored payload did not reach the real UI');
          return { visibleText, dialogs, externalRequests, executedScripts, unsafeLinks, keyboardAccessible };
        } finally { await workspace.close(); }
      },
    },
  };
}

function fixtureOptions(scenario: Scenario) {
  return {
    judgmentSource: 'fixture-stubs' as const,
    guard: async () => scenario.guardStub,
    judge: async () => ({ ...scenario.judgeStub, label: scenario.judgeStub.label as 'consistent' | 'contradiction' | 'insufficient_evidence' }),
  };
}

export async function createHarness(): Promise<Harness> {
  let directory: string | undefined;
  let store: ExecutionStore | undefined;
  let api: Awaited<ReturnType<typeof buildApp>> | undefined;
  let ownerSession: ReturnType<Awaited<ReturnType<typeof buildApp>>['sessions']['create']>;
  let otherSession: typeof ownerSession;
  async function setup() {
    directory ??= await mkdtemp(join(tmpdir(), 'aw-runner-'));
    store ??= new ExecutionStore(join(directory, 'executions.sqlite'));
    return new Runner(store);
  }
  async function setupApi() {
    if (api) return api;
    directory ??= await mkdtemp(join(tmpdir(), 'aw-runner-'));
    const catalog = scenarios.map(parseScenario);
    const happy = catalog.find(s => s.id === 'RF-001')!;
    happy.messages.push('owned-trace-canary', 'Authorization: Bearer aw-test-secret-do-not-export');
    catalog.find(s => s.id === 'RF-002')!.messages = ['other-workspace-canary'];
    const service = await Workbench.open(join(directory, 'api.sqlite'), catalog, ['aw-test-secret-do-not-export']);
    const config = { scenarioPack: 'refunds-v1' as const, agentId: 'fixture-safe' as const,
      repeats: 1, scenarioIds: ['RF-001'], fixtureJudges: true };
    const seed = service.enqueue('local-owner', config);
    await service.idle();
    const completed = service.suites.get(seed.id, 'local-owner')!;
    service.suites.save({ ...completed, id: 'owner-suite' });
    const other = service.enqueue('other-owner', { ...config, scenarioIds: ['RF-002'] });
    await service.idle();
    service.suites.save({ ...service.suites.get(other.id, 'other-owner')!, id: 'other-suite' });
    const root = join(directory, 'artifacts');
    const outside = join(directory, 'outside');
    await mkdir(root); await mkdir(outside);
    await writeFile(join(root, 'owned.txt'), 'owned-artifact-canary');
    await writeFile(join(outside, 'secret.txt'), 'outside-artifact-canary');
    await symlink(outside, join(root, 'outside-link'), 'junction');
    service.suites.addArtifact('owned-artifact', 'local-owner', 'owned.txt');
    service.suites.addArtifact('outside-symlink', 'local-owner', 'outside-link/secret.txt');
    api = await buildApp({ workbench: service, artifactRoot: root });
    ownerSession = api.sessions.create('local-owner');
    otherSession = api.sessions.create('other-owner');
    return api;
  }
  return {
    api: {
      async request(input) {
        const { app, service } = await setupApi();
        const session = input.session === 'owner' ? ownerSession : input.session === 'other' ? otherSession : undefined;
        const headers: Record<string, string> = { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000',
          ...(input.body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(session ? { cookie: `aw_session=${session.token}` } : {}),
          ...(input.csrf && session ? { 'x-aw-csrf': session.csrf } : {}), ...input.headers };
        const before = service.mutations;
        const response = await app.inject({ method: input.method as 'GET' | 'POST', url: input.path,
          headers, payload: input.body === undefined ? undefined : typeof input.body === 'string' ? input.body : JSON.stringify(input.body) });
        return { status: response.statusCode, headers: Object.fromEntries(Object.entries(response.headers).map(([k, v]) => [k, String(v)])),
          text: response.body, outbound: [], mutationCount: service.mutations - before };
      },
    },
    ...browserCapability(),
    egress: { async check(input) { return { allowed: approveEndpoint(input), outbound: [] }; } },
    decisions: {
      async normalize(_provider, question, answer) { return normalizeAnswer(question as Question, answer); },
      async buildEvidence(input) { return buildEvidence(input.trusted as Record<string, unknown>, input.untrusted as Record<string, unknown>); },
      async cacheKeys(changes) {
        const trusted = { provider: 'laya', modelRevision: 'pinned', rubricVersion: 'v1', tokenizerRevision: 'v1',
          policyVersion: 'p1', guardVersion: 'v1', evidence: 'evidence', settings: {}, workspaceId: 'test', executionId: 'execution' };
        return changes.map(change => cacheKey({ ...trusted, ...change }));
      },
      async evaluate(input) {
        const model = input.provider === 'laya' ? 'laya-typed-decisions' : 'jev-pinned-test';
        const transport = new ControlledTransport(async () => { if (input.error !== undefined) throw new Error(String(input.error)); return input.response; });
        const client = new SystemOneClient({ provider: input.provider, model, modelRevision: model,
          baseUrl: input.provider === 'laya' ? 'http://127.0.0.1:8000' : 'https://api.typesafe.ai',
          networkMode: input.networkMode ?? 'local', cloudAllowed: input.cloudAllowed ?? false, calibrated: input.calibrated ?? false,
          contextLimit: input.contextLimit ?? 1024, workspaceId: 'test', executionId: 'execution', tokenizerRevision: 'test',
          rubricVersion: 'test', policyVersion: 'p1', guardVersion: 'test' }, transport.send, async () => input.inputTokens ?? 0);
        const result = await client.evaluate({ evidence: input.evidence ?? '', complete: input.complete ?? false, critical: input.critical,
          deterministicFailure: input.deterministicFailure, purpose: input.purpose });
        return { ...result, outbound: [], ...(transport.requests[0] ? { request: { url: transport.requests[0].url, body: transport.requests[0].body as Record<string, unknown> } } : { request: undefined }) };
      },
    },
    security: {
      async exercise(input) {
        const boundary = new IsolationBoundary(async () => input.detector);
        const before = boundary.snapshot();
        const record = await boundary.ingest(input.attack.payload, input.attack.surface, input.mode);
        for (const operation of ['shell', 'arbitrary_http', 'read_secret', 'change_policy', 'enable_cloud']) boundary.authorizeHostOperation(operation);
        const after = boundary.snapshot();
        return { hostMutations: JSON.stringify(before) === JSON.stringify(after) ? 0 : 1,
          arbitraryToolExecuted: boundary.deniedOperations.length !== 5, secretsExposed: [], outbound: [],
          rawPayload: record.rawPayload, trustedPolicyVersion: after.policyVersion, guardCalls: record.guardCalls,
          reviewRequired: record.reviewRequired };
      },
    },
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
      await api?.app.close();
      store?.close();
      if (directory) await rm(directory, { recursive: true, force: true });
    },
  };
}
