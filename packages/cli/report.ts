import type { RunResult, Scenario } from '../contracts/scenario.ts';

export type SuiteRun = {
  scenarioId: string; title: string; repetition: number;
  before: Scenario['initial']; after: { now: string; verified: boolean; orders: Scenario['initial']['orders'] };
  result: RunResult;
};
export type Report = {
  schemaVersion: 1; agentMode: 'scripted-fixture'; judgeMode: RunResult['judgmentSource'] | 'mixed';
  counts: Record<RunResult['status'], number>; runs: SuiteRun[];
};
export function report(runs: SuiteRun[]): Report {
  const counts = { passed: 0, failed: 0, needs_review: 0, error: 0, cancelled: 0 };
  for (const run of runs) counts[run.result.status]++;
  const sources = new Set(runs.map(run => run.result.judgmentSource));
  return { schemaVersion: 1, agentMode: 'scripted-fixture',
    judgeMode: sources.size > 1 ? 'mixed' : sources.values().next().value ?? 'unverified-review', counts, runs };
}

export function exitCode(suite: Report, allowReview = false): number {
  return suite.counts.failed || suite.counts.error || suite.counts.cancelled ||
    (!allowReview && suite.counts.needs_review) ? 1 : 0;
}

export function xmlText(value: string): string {
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '\uFFFD')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

export function junit(suite: Report): string {
  const { counts } = suite;
  const cases = suite.runs.map(run => {
    const result = run.result;
    const details = result.checks.filter(c => c.status !== 'pass').map(c => `${c.id}: ${c.status}`).join('; ');
    let child = '';
    if (result.status === 'failed') child = `<failure message="${xmlText(details)}"/>`;
    if (result.status === 'error') child = '<error message="Execution limit or infrastructure error"/>';
    if (result.status === 'needs_review' || result.status === 'cancelled') child = `<skipped message="${result.status}"/>`;
    return `<testcase classname="refund.scripted" name="${xmlText(`${run.scenarioId} ${run.title} #${run.repetition}`)}">${child}</testcase>`;
  }).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="AgentWindTunnel" tests="${suite.runs.length}" failures="${counts.failed}" errors="${counts.error}" skipped="${counts.needs_review + counts.cancelled}">\n<properties><property name="agentMode" value="${suite.agentMode}"/><property name="judgeMode" value="${suite.judgeMode}"/></properties>\n${cases}\n</testsuite>\n`;
}
