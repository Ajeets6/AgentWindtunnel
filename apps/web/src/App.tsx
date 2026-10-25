import { useCallback, useEffect, useMemo, useState } from 'react';
import { request, signIn } from './api.ts';
import { Inspector, Outcome } from './Inspector.tsx';
import type { Suite, SuiteDetail, ExecutionView } from '../../../packages/contracts/api.ts';
import type { Scenario } from '../../../packages/contracts/scenario.ts';

const navigation = [{ id: 'runs', label: 'Runs', glyph: '▤' }, { id: 'scenarios', label: 'Scenarios', glyph: '◇' },
  { id: 'agents', label: 'Agents', glyph: '⌘' }, { id: 'judges', label: 'Judge lab', glyph: '⊞' }, { id: 'settings', label: 'Settings', glyph: '⚙' }];

export function App() {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [page, setPage] = useState('runs');
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [suites, setSuites] = useState<Suite[]>([]);
  const [suiteId, setSuiteId] = useState('');
  const [suite, setSuite] = useState<SuiteDetail>();
  const [executionId, setExecutionId] = useState('');
  const [scenarioId, setScenarioId] = useState('all');
  const [repeats, setRepeats] = useState(1);
  const [fixtureJudges, setFixtureJudges] = useState(false);
  const [launching, setLaunching] = useState(false);
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [connection, setConnection] = useState('');

  const loadSuites = useCallback(async () => {
    const result = await request<{ suites: Suite[] }>('/api/suites');
    setSuites(result.suites);
    return result.suites;
  }, []);
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        await signIn();
        const [catalog, saved] = await Promise.all([request<{ scenarios: Scenario[] }>('/api/scenarios'), loadSuites()]);
        if (!active) return;
        setScenarios(catalog.scenarios);
        if (saved.length) setSuiteId(saved[0].id);
        setReady(true);
      } catch (error) { if (active) setError(error instanceof Error ? error.message : 'Unable to connect'); }
    })();
    return () => { active = false; };
  }, [loadSuites]);

  useEffect(() => {
    if (!ready || !suiteId) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setSuite(undefined);
    setExecutionId('');
    const stream = new EventSource(`/api/suites/${encodeURIComponent(suiteId)}/events`);
    const refresh = async () => {
      try {
        const detail = await request<SuiteDetail>(`/api/suites/${encodeURIComponent(suiteId)}`);
        if (!active) return;
        setSuite(detail);
        setExecutionId(previous => previous || detail.executions[0]?.id || '');
        await loadSuites();
        if (!['queued', 'running'].includes(detail.status)) { stream.close(); setConnection('Up to date'); }
      } catch (error) { if (active) setError(error instanceof Error ? error.message : 'Unable to load suite'); }
    };
    stream.onopen = () => setConnection('Live updates');
    stream.onerror = () => { if (active) setConnection('Reconnecting…'); };
    stream.addEventListener('progress', () => { clearTimeout(timer); timer = setTimeout(refresh, 80); });
    void refresh();
    return () => { active = false; clearTimeout(timer); stream.close(); };
  }, [suiteId, ready, loadSuites]);

  const executions = suite?.executions ?? [];
  const selected = executions.find(e => e.id === executionId);
  const needsReview = (execution: ExecutionView) => execution.checks.some(check => check.required && check.status === 'needs_review');
  const visible = executions.filter(e => filter === 'all' || (filter === 'needs_review' ? needsReview(e) : e.status === filter));
  const completed = executions.filter(e => e.status !== 'running').length;
  const passed = executions.filter(e => e.status === 'passed').length;
  const reviews = executions.filter(needsReview).length;
  const violations = executions.reduce((sum, e) => sum + e.checks.filter(c => c.status === 'fail' && !['message_truth', 'injection'].includes(c.id)).length, 0);
  const filteredScenarios = useMemo(() => scenarios.filter(s => `${s.id} ${s.title} ${s.family}`.toLowerCase().includes(search.toLowerCase())), [scenarios, search]);
  const activeSuite = suite && ['queued', 'running'].includes(suite.status);

  async function launch(chosen?: string) {
    setLaunching(true); setError('');
    try {
      const selection = chosen ?? scenarioId;
      const result = await request<{ id: string }>('/api/suites', { method: 'POST', body: JSON.stringify({
        scenarioPack: 'refunds-v1', agentId: 'fixture-safe', repeats, fixtureJudges,
        ...(selection !== 'all' ? { scenarioIds: [selection] } : {}),
      }) });
      await loadSuites(); setSuiteId(result.id); setPage('runs'); setFilter('all');
    } catch (error) { setError(error instanceof Error ? error.message : 'Unable to launch'); }
    finally { setLaunching(false); }
  }
  async function cancel() {
    try {
      await request(`/api/suites/${suiteId}/cancel`, { method: 'POST' });
      setSuite(await request<SuiteDetail>(`/api/suites/${suiteId}`));
    } catch (error) { setError(error instanceof Error ? error.message : 'Unable to cancel'); }
  }

  return <div className="app-shell"><a href="#main" className="skip-link">Skip to workspace</a>
    <aside className="sidebar"><a className="brand" href="#main" aria-label="AgentWindTunnel home" onClick={() => setPage('runs')}>
      <svg className="brand-mark" viewBox="0 0 32 32" fill="none" aria-hidden="true"><path d="M3 8h16c10 0 10 16 0 16H3M3 16h23M3 12h11M3 20h11" stroke="currentColor" strokeWidth="2.2" /></svg>
      <span>Agent<span className="brand-second">WindTunnel</span></span></a>
      <div className="workspace-label">LOCAL WORKSPACE <span className="mono">01</span></div>
      <nav aria-label="Main navigation">{navigation.map(item => <button key={item.id} className={page === item.id ? 'nav-item active' : 'nav-item'}
        aria-current={page === item.id ? 'page' : undefined} onClick={() => setPage(item.id)}><span className="nav-glyph" aria-hidden="true">{item.glyph}</span>{item.label}
        {item.id === 'scenarios' && <span className="nav-count">{scenarios.length || '—'}</span>}</button>)}</nav>
      <div className="sidebar-bottom"><div className="local-indicator"><span /> Local only</div><p>Your data stays here.<br />No inference calls enabled.</p><span className="version mono">WORKBENCH / v0.1</span></div>
    </aside>
    <div className="main-shell"><header className="topbar"><span>Workspace <span className="breadcrumb">/</span> <strong>{navigation.find(n => n.id === page)?.label}</strong></span>
      <div className="topbar-right"><span className="mono">REFUNDS · AUD</span><span className="status-dot" /> <span>Local environment</span></div></header>
      <main id="main" tabIndex={-1}>
        {error && <div className="error-banner" role="alert"><span>{error}</span><button aria-label="Dismiss error" onClick={() => setError('')}>×</button></div>}
        {!ready ? <section className="connect-panel"><span className="eyebrow">YOUR LOCAL TEST ENVIRONMENT</span><h1>Welcome to the workbench.</h1><p>Open the sign-in link printed by <code>npm start</code> to connect securely to your local workspace.</p><p className="muted">The link is single-use. Your browser session lasts 12 hours.</p></section> : <>
        <div className="page-heading"><div><p className="eyebrow">AGENT EVALUATION / REFUNDS</p><h1>{page === 'runs' ? 'Refund workbench' : page === 'scenarios' ? 'Scenario library' : page === 'agents' ? 'Agents' : page === 'judges' ? 'Judge lab' : 'Workspace settings'}</h1>
          <p className="page-subtitle">{page === 'runs' ? 'Check what changed. Then check what the agent said.' : page === 'scenarios' ? 'Forty authored cases. Realistic mistakes. Independently checked outcomes.' : page === 'agents' ? 'Choose the behavior you want to put under test.' : page === 'judges' ? 'Uncertainty stays visible until it is reviewed.' : 'A local workspace with explicit boundaries.'}</p></div>
          {page === 'runs' && <span className="pack-label"><span className="pack-symbol" aria-hidden="true">◇</span> refunds-v1 <span>40 scenarios</span></span>}</div>

        {page === 'runs' && <>
          <section className="run-controls" aria-label="Suite configuration"><div className="control-grid">
            <label>SCENARIOS<select aria-label="Scenarios" value={scenarioId} onChange={e => setScenarioId(e.target.value)}><option value="all">Refunds v1 · all 40 scenarios</option>{scenarios.map(s => <option key={s.id} value={s.id}>{s.id} · {s.title}</option>)}</select></label>
            <label>AGENT<select aria-label="Agent" defaultValue="fixture-safe"><option value="fixture-safe">Authored fixture agent</option></select></label>
            <label className="repeat-control">REPEATS<input aria-label="Repeats" type="number" min="1" max="10" value={repeats} onChange={e => setRepeats(Number(e.target.value))} /></label>
            <button className="primary-button" disabled={launching || !Number.isInteger(repeats) || repeats < 1 || repeats > 10} onClick={() => void launch()}>{launching ? 'Starting…' : 'Run suite'}<span aria-hidden="true">↗</span></button>
          </div><div className="controls-footer"><label className="checkbox-label"><input type="checkbox" checked={fixtureJudges} onChange={e => setFixtureJudges(e.target.checked)} /> Use synthetic fixture judgments</label>
            <span>{fixtureJudges ? 'Synthetic answers · no model accuracy claim' : 'No judge connected · semantics remain in review'}</span></div></section>
          <section className="metrics" aria-label="Suite metrics">
            <Metric label="PASSED RUNS" value={`${passed}`} suffix={`/ ${suite?.total ?? 0}`} note="Includes all requested executions" tone="green" />
            <Metric label="BUSINESS VIOLATIONS" value={`${violations}`} note="Required backend checks that failed" tone="red" />
            <Metric label="NEEDS REVIEW" value={`${reviews}`} suffix={`/ ${suite?.total ?? 0}`} note="Unresolved judgments stay unresolved" tone="amber" />
            <Metric label="API SPEND" value="$0.00" note="Scripted runs · no inference requests" tone="blue" />
          </section>
          <section className="results-section" aria-label="Suite results"><div className="section-heading"><div className="row"><h2>Suite results</h2><span className="count-chip">{completed} / {suite?.total ?? 0}</span>{suite && <Outcome status={suite.status} />}</div>
            <div className="row result-actions">{suite && <><span className="connection-label">{connection}</span>{activeSuite && <button className="small-button" onClick={() => void cancel()}>Cancel suite</button>}
              <a className="small-button" href={`/api/suites/${suite.id}/export`} download>JSON ↓</a><a className="small-button" href={`/api/suites/${suite.id}/export?format=junit`} download>JUnit ↓</a></>}</div></div>
            <div className="results-toolbar"><div className="filter-tabs" aria-label="Filter outcomes">{[{ id: 'all', name: 'All runs' }, { id: 'failed', name: 'Failed' }, { id: 'needs_review', name: 'Review' }, { id: 'passed', name: 'Passed' }].map(f => <button key={f.id} aria-pressed={filter === f.id} className={filter === f.id ? 'active' : ''} onClick={() => setFilter(f.id)}>{f.name}</button>)}</div>
              <label className="suite-select"><span className="sr-only">Saved suite</span><select aria-label="Saved suite" value={suiteId} onChange={e => { setSuiteId(e.target.value); setFilter('all'); }}><option value="">Select a saved suite</option>{suites.map(s => <option key={s.id} value={s.id}>{new Date(s.createdAt).toLocaleString()} · {s.id.slice(0, 8)}</option>)}</select></label></div>
            {!suiteId ? <div className="empty-state"><div className="empty-graphic" aria-hidden="true">↗</div><h3>Find the failure before your customer does.</h3><p>Run the full pack, or start with a committed-timeout case<br className="desktop-break" /> to see a duplicate refund emerge in the ledger.</p><button className="text-button" disabled={launching} onClick={() => { setScenarioId('RF-018'); void launch('RF-018'); }}>Try the duplicate-refund case <span aria-hidden="true">→</span></button></div>
              : !suite ? <div className="empty-state" role="status">Loading suite…</div> : visible.length === 0 ? <div className="empty-state"><h3>{activeSuite ? 'The suite is getting started.' : 'No runs match this filter.'}</h3><p>{activeSuite ? 'Progress will appear here automatically.' : 'Choose another outcome to inspect the suite.'}</p></div>
                : <div className="table-scroll"><table className="results-table"><thead><tr><th>SCENARIO</th><th>REPEAT</th><th>OUTCOME</th><th>REQUIRED CHECKS</th><th>REFUNDS</th><th>JUDGMENT</th></tr></thead><tbody>{visible.map(e => <tr key={e.id} className={executionId === e.id ? 'selected' : ''}>
                  <td><button className="scenario-link" aria-expanded={executionId === e.id} onClick={() => setExecutionId(e.id)}><span className="mono">{e.scenarioId}</span><strong>{e.title}</strong></button></td><td className="mono">{String(e.repetition).padStart(2, '0')}</td><td><Outcome status={e.status} /></td>
                  <td className="check-summary">{e.checks.filter(c => c.status === 'fail').map(c => c.id).join(', ') || (e.status === 'needs_review' ? 'Semantic review' : e.status === 'running' ? 'In progress' : 'No proven violations')}</td>
                  <td className="mono">{e.result?.refunds.length ?? '—'}</td><td className="judgment-label">{e.result?.judgmentSource === 'fixture-stubs' ? 'Fixture stub' : 'Unverified'}</td></tr>)}</tbody></table></div>}
          </section>
          {selected && <Inspector key={selected.id} execution={selected} onClose={() => setExecutionId('')} />}
          <p className="workspace-footnote"><span aria-hidden="true">↳</span> Negative fixture agents are designed to fail. A detected mistake is a successful workbench test.</p>
        </>}

        {page === 'scenarios' && <section className="library"><div className="section-heading"><h2>Authored refund scenarios <span className="count-chip">{scenarios.length}</span></h2><label className="search-label"><span className="sr-only">Search scenarios</span><input aria-label="Search scenarios" placeholder="Search ID, title or family…" value={search} onChange={e => setSearch(e.target.value)} /></label></div>
          <div className="scenario-cards">{filteredScenarios.map(s => <article key={s.id} className="scenario-card"><div className="row spread"><span className="mono scenario-id">{s.id}</span><span className="family-label">{s.family.replaceAll('-', ' ')}</span></div><h3>{s.title}</h3><p>{s.messages[0]}</p><div className="card-details"><span>{s.steps.length} tool calls</span><span>{s.faults.length ? `${s.faults.length} injected faults` : 'No injected faults'}</span></div><div className="row spread"><span className="muted mono">policy {s.policyVersion} · v{s.version}</span><button className="text-button" disabled={launching} onClick={() => { setScenarioId(s.id); void launch(s.id); }}>Run case →</button></div></article>)}</div>
          {!filteredScenarios.length && <p className="empty-state">No scenarios match your search.</p>}</section>}

        {page === 'agents' && <section className="info-card"><div className="row spread"><span className="eyebrow">AVAILABLE AGENT</span><span className="mode-badge">SCRIPTED</span></div><h2>Authored fixture agent</h2><p>Replays the actions written into each scenario, including deliberate mistakes. This lets you verify the workbench without connecting a model.</p><dl className="settings-list"><div><dt>Backend</dt><dd>Isolated mock shop</dd></div><div><dt>Inference requests</dt><dd>None</dd></div><div><dt>Actual payment access</dt><dd>None</dd></div><div><dt>Model adapters</dt><dd>Not connected</dd></div></dl><button className="primary-button" onClick={() => setPage('runs')}>Run a scenario <span aria-hidden="true">↗</span></button></section>}

        {page === 'judges' && <section className="info-card"><span className="eyebrow">REVIEW WORKSPACE</span><h2>No automatic semantic acceptance.</h2><p>Default runs leave message truth and injection judgments in review. Synthetic fixture judgments are available for testing the workbench; they do not establish judge accuracy.</p>
          <div className="review-list">{executions.filter(needsReview).map(e => <button className="review-row" key={e.id} onClick={() => { setPage('runs'); setFilter('needs_review'); setExecutionId(e.id); }}><span className="mono">{e.scenarioId}</span><span>{e.title}</span><Outcome status="needs_review" /><span aria-hidden="true">→</span></button>)}</div>
          {!reviews && <p className="panel-note">No review cases in the selected suite. Start a run without synthetic judgments to inspect unresolved checks.</p>}<p className="muted">Human adjudication and Laya/Jev provider connections are not enabled yet.</p></section>}

        {page === 'settings' && <section className="info-card"><span className="eyebrow">WORKSPACE BOUNDARIES</span><h2>Local by default.</h2><dl className="settings-list"><div><dt>Network mode</dt><dd><span className="local-indicator"><span /> Local only</span></dd></div><div><dt>Service binding</dt><dd className="mono">127.0.0.1</dd></div><div><dt>Storage</dt><dd>Local SQLite + artifacts</dd></div><div><dt>Cloud inference</dt><dd>Disabled</dd></div><div><dt>Browser session</dt><dd>HttpOnly · 12 hours</dd></div><div><dt>Currency / policy</dt><dd>AUD integer cents / p1</dd></div><div><dt>Scenario pack</dt><dd>refunds-v1 · 40 authored cases</dd></div></dl><p className="panel-note">Provider configuration and cloud access are not enabled. Run data stays in the local workspace.</p></section>}
        </>}
      </main><footer className="app-footer"><span>AgentWindTunnel</span><span>Evidence over eloquence.</span><span className="mono">LOCAL / v0.1</span></footer>
    </div>
  </div>;
}

function Metric({ label, value, suffix, note, tone }: { label: string; value: string; suffix?: string; note: string; tone: string }) {
  return <div className={`metric ${tone}`}><p className="eyebrow"><span />{label}</p><div className="metric-value">{value}<span>{suffix}</span></div><p className="metric-note">{note}</p></div>;
}
