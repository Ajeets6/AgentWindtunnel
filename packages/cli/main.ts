import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { parseScenario } from '../contracts/scenario.ts';
import { Runner } from '../runner/runner.ts';
import { ExecutionStore } from '../runner/store.ts';
import { report, exitCode, junit } from './report.ts';
import type { SuiteRun } from './report.ts';
import type { Scenario } from '../contracts/scenario.ts';

async function main(): Promise<number> {
  const { values } = parseArgs({ options: {
    scenario: { type: 'string' }, repeats: { type: 'string', default: '1' },
    format: { type: 'string', default: 'json' }, db: { type: 'string', default: 'data/windtunnel.sqlite' },
    output: { type: 'string' }, resume: { type: 'string' },
    'fixture-judges': { type: 'boolean', default: false },
    'allow-review': { type: 'boolean', default: false }, help: { type: 'boolean', short: 'h' },
  }, strict: true, allowPositionals: false });
  if (values.help) {
    process.stdout.write(`AgentWindTunnel scripted refund simulator\n\nUsage: npm run simulate -- [options]\n  --scenario RF-018       One scenario; default is the entire pack\n  --repeats 1            Repetitions, 1–100\n  --fixture-judges       Use synthetic fixture judgments (no real model)\n  --allow-review         Permit unresolved reviews in the exit status\n  --format json|junit    Report format\n  --output PATH          Write report to file; default is stdout\n  --db PATH              SQLite path; default data/windtunnel.sqlite\n  --resume ID            Resume an execution from its saved checkpoint\n\nExit 1 means a failed/error/cancelled run or an unresolved review. Negative\nfixture agents deliberately fail. No model or network requests are made.\n`);
    return 0;
  }
  if (!/^(?:[1-9]|[1-9][0-9]|100)$/.test(values.repeats!)) throw new Error('Repeats must be an integer from 1 to 100');
  if (!['json', 'junit'].includes(values.format!)) throw new Error('Format must be json or junit');
  if (values.resume && (values.scenario || values.repeats !== '1')) throw new Error('Resume cannot be combined with scenario selection or repeats');
  const directory = new URL('../../scenarios/refunds/', import.meta.url);
  const scenarios: Scenario[] = [];
  const ids = new Set<string>();
  for (const name of (await readdir(directory)).filter(n => n.endsWith('.json')).sort()) {
    const pack: unknown = JSON.parse(await readFile(new URL(name, directory), 'utf8'));
    if (!Array.isArray(pack)) throw new Error('Scenario pack must be an array');
    for (const raw of pack) {
      const scenario = parseScenario(raw);
      if (ids.has(scenario.id)) throw new Error('Duplicate scenario ID');
      ids.add(scenario.id);
      scenarios.push(scenario);
    }
  }
  const selected = scenarios.filter(s => !values.scenario || s.id === values.scenario);
  if (!selected.length) throw new Error('Unknown scenario ID');
  const databasePath = resolve(values.db!);
  if (values.output && resolve(values.output) === databasePath) throw new Error('Report output cannot overwrite the database');
  await mkdir(dirname(databasePath), { recursive: true });
  const store = new ExecutionStore(databasePath);
  const runner = new Runner(store);
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.on('SIGINT', stop);
  const runs: SuiteRun[] = [];
  try {
    async function execute(scenario: Scenario, repetition: number, resume?: string) {
      const options = { signal: controller.signal, ...(values['fixture-judges'] ? {
        judge: async () => scenario.judgeStub, guard: async () => scenario.guardStub,
        judgmentSource: 'fixture-stubs' as const,
      } : {}) };
      const result = resume ? await runner.resume(resume, options) : await runner.run(scenario, options);
      const checkpoint = store.load(result.executionId);
      runs.push({ scenarioId: scenario.id, title: scenario.title, repetition,
        before: scenario.initial, after: { now: new Date(checkpoint.state.now).toISOString(),
          verified: checkpoint.state.verified, orders: checkpoint.state.orders }, result });
    }
    if (values.resume) await execute(store.load(values.resume).scenario, 1, values.resume);
    else for (const scenario of selected) {
      for (let repetition = 1; repetition <= Number(values.repeats); repetition++) {
        if (controller.signal.aborted) break;
        await execute(scenario, repetition);
      }
      if (controller.signal.aborted) break;
    }
    const suite = report(runs);
    const output = values.format === 'junit' ? junit(suite) : JSON.stringify(suite, null, 2) + '\n';
    if (values.output) {
      await mkdir(dirname(resolve(values.output)), { recursive: true });
      await writeFile(resolve(values.output), output, 'utf8');
    } else process.stdout.write(output);
    return controller.signal.aborted ? 1 : exitCode(suite, values['allow-review']);
  } finally {
    process.off('SIGINT', stop);
    store.close();
  }
}

try { process.exitCode = await main(); }
catch (error) {
  process.stderr.write(`AgentWindTunnel: ${error instanceof Error ? error.message : 'Execution failed'}\n`);
  process.exitCode = 2;
}
