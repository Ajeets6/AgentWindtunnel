import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { request, signIn } from './api.ts';
import { Inspector, Outcome } from './Inspector.tsx';
import type { Suite, SuiteDetail, ExecutionView } from '../../../packages/contracts/api.ts';
import type { Scenario } from '../../../packages/contracts/scenario.ts';
import type { ProviderConfig } from '../../../packages/contracts/providers.ts';
import { AgentEditor, ProviderSettings, ReviewWorkspace, ScenarioEditor } from './Management.tsx';

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
  const [defenseMode, setDefenseMode] = useState<'observe' | 'enforce'>('observe');
  const [launching, setLaunching] = useState(false);
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [connection, setConnection] = useState('');
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  const [agents, setAgents] = useState<{ id: string; name: string; kind: string; description: string }[]>([]);
  const [agentId, setAgentId] = useState('fixture-safe');
  const [judgeId, setJudgeId] = useState('');
  const [guardId, setGuardId] = useState('');
  const [budgetUsd, setBudgetUsd] = useState(0);
  const [baselineId, setBaselineId] = useState('');
  const [comparison, setComparison] = useState<{ pairs: { scenarioId: string; repetition: number; previous: string | null; current: string; regression: boolean }[] }>();
  const defaultsApplied = useRef(false);
  const refreshCapabilities = useCallback(async () => {
    const [catalog, settings, agentList] = await Promise.all([request<{ scenarios: Scenario[] }>('/api/scenarios'),
      request<{ providers: ProviderConfig[] }>('/api/settings'), request<{ agents: typeof agents }>('/api/agents')]);
    setScenarios(catalog.scenarios); setProviders(settings.providers); setAgents(agentList.agents);
    if (!defaultsApplied.current) {
      defaultsApplied.current = true;
      if (settings.providers.some(p => p.id === 'laya-local' && p.enabled)) { setJudgeId('laya-local'); setGuardId('laya-local'); }
      if (agentList.agents.some(a => a.id === 'ollama-qwen3-careful')) setAgentId('ollama-qwen3-careful');
    }
  }, []);

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
        await refreshCapabilities();
        if (saved.length) setSuiteId(saved[0].id);
        setReady(true);
      } catch (error) { if (active) setError(error instanceof Error ? error.message : 'Unable to connect'); }
    })();
    return () => { active = false; };
  }, [loadSuites, refreshCapabilities]);

  useEffect(() => {
    if (!ready || !suiteId || !baselineId) { setComparison(undefined); return; }
    void request<{ pairs: NonNullable<typeof comparison>['pairs'] }>(`/api/suites/${suiteId}/compare?baseline=${encodeURIComponent(baselineId)}`)
      .then(setComparison).catch(error => setError(String(error)));
  }, [ready, suiteId, baselineId, suite?.status, suite?.executions.length]);

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
  const needsReview = (execution: ExecutionView) => execution.checks.some(check => check.required && (execution.reviews?.filter(r => r.checkId === check.id).at(-1)?.status ?? check.status) === 'needs_review');
  const visible = executions.filter(e => filter === 'all' || (filter === 'needs_review' ? needsReview(e) : (e.adjudicatedStatus ?? e.status) === filter));
  const completed = executions.filter(e => e.status !== 'running').length;
  const passed = executions.filter(e => (e.adjudicatedStatus ?? e.status) === 'passed').length;
  const reviews = executions.filter(needsReview).length;
  const violations = executions.reduce((sum, e) => sum + e.checks.filter(c => c.status === 'fail' && !['message_truth', 'injection'].includes(c.id)).length, 0);
  const filteredScenarios = useMemo(() => scenarios.filter(s => `${s.id} ${s.title} ${s.family}`.toLowerCase().includes(search.toLowerCase())), [scenarios, search]);
  const activeSuite = suite && ['queued', 'running'].includes(suite.status);

  async function launch(chosen?: string) {
    setLaunching(true); setError('');
    try {
      const selection = chosen ?? scenarioId;
      const result = await request<{ id: string }>('/api/suites', { method: 'POST', body: JSON.stringify({
        scenarioPack: 'refunds-v1', agentId, repeats, fixtureJudges, defenseMode, cloudBudgetMicros: Math.round(budgetUsd * 1000000),
        ...(judgeId ? { judgeProviderId: judgeId } : {}), ...(guardId ? { guardProviderId: guardId } : {}), ...(baselineId ? { baselineId } : {}),
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
      <div className="sidebar-bottom"><div className="local-indicator"><span /> {providers.some(p => p.enabled && p.networkMode === 'hybrid') ? 'Hosted roles configured' : 'Local workspace'}</div><p>{providers.filter(p => p.enabled).length} enabled providers.<br />Cloud requires a reserved budget.</p><span className="version mono">WORKBENCH / v0.1</span></div>
    </aside>
    <div className="main-shell"><header className="topbar"><span>Workspace <span className="breadcrumb">/</span> <strong>{navigation.find(n => n.id === page)?.label}</strong></span>
      <div className="topbar-right"><span className="mono">REFUNDS · AUD</span><span className="status-dot" /> <span>Local environment</span></div></header>
      <main id="main" tabIndex={-1}>
        {error && <div className="error-banner" role="alert"><span>{error}</span><button aria-label="Dismiss error" onClick={() => setError('')}>×</button></div>}
        {!ready ? <section className="connect-panel"><span className="eyebrow">YOUR LOCAL TEST ENVIRONMENT</span><h1>Welcome to the workbench.</h1><p>Open the sign-in link printed by <code>npm start</code> to connect securely to your local workspace.</p><p className="muted">The link is single-use. Your browser session lasts 12 hours.</p></section> : <>
        <div className="page-heading"><div><p className="eyebrow">AGENT EVALUATION / REFUNDS</p><h1>{page === 'runs' ? 'Refund workbench' : page === 'scenarios' ? 'Scenario library' : page === 'agents' ? 'Agents' : page === 'judges' ? 'Judge lab' : 'Workspace settings'}</h1>
          <p className="page-subtitle">{page === 'runs' ? 'Check what changed. Then check what the agent said.' : page === 'scenarios' ? 'Forty authored cases. Realistic mistakes. Independently checked outcomes.' : page === 'agents' ? 'Choose the behavior you want to put under test.' : page === 'judges' ? 'Uncertainty stays visible until it is reviewed.' : 'A local workspace with explicit boundaries.'}</p></div>
          {page === 'runs' && <span className="pack-label"><span className="pack-symbol" aria-hidden="true">◇</span> refunds-v1 <span>{scenarios.length} scenarios</span></span>}</div>

        {page === 'runs' && <>
          <section className="run-controls" aria-label="Suite configuration"><div className="control-grid">
            <label>SCENARIOS<select aria-label="Scenarios" value={scenarioId} onChange={e => setScenarioId(e.target.value)}><option value="all">Refunds v1 · all {scenarios.length} scenarios</option>{scenarios.map(s => <option key={s.id} value={s.id}>{s.id} · {s.title}</option>)}</select></label>
            <label>AGENT<select aria-label="Agent" value={agentId} onChange={e => setAgentId(e.target.value)}>{agents.map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></label>
            <label className="repeat-control">REPEATS<input aria-label="Repeats" type="number" min="1" max="10" value={repeats} onChange={e => setRepeats(Number(e.target.value))} /></label>
            <button className="primary-button" disabled={launching || !Number.isInteger(repeats) || repeats < 1 || repeats > 10} onClick={() => void launch()}>{launching ? 'Starting…' : 'Run suite'}<span aria-hidden="true">↗</span></button>
          </div><div className="controls-footer"><label className="checkbox-label"><input type="checkbox" checked={fixtureJudges} onChange={e => setFixtureJudges(e.target.checked)} /> Use synthetic fixture judgments</label>
            <span>{fixtureJudges ? 'Synthetic answers · no model accuracy claim' : judgeId ? 'Provider diagnostics · human-gated' : 'No judge connected · semantics remain in review'}</span></div>
            <details className="advanced-controls"><summary>Judges, baseline & hosted budget</summary><div className="management-grid">
              <label>Judge provider<select value={judgeId} onChange={e => setJudgeId(e.target.value)}><option value="">Human review only</option>{providers.filter(p => p.enabled && p.roles.includes('judge')).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
              <label>Injection guard<select value={guardId} onChange={e => setGuardId(e.target.value)}><option value="">Unverified / review</option>{providers.filter(p => p.enabled && p.roles.includes('injection-guard')).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
              <label>Defense mode<select aria-label="Defense mode" value={defenseMode} onChange={e => setDefenseMode(e.target.value as typeof defenseMode)}><option value="observe">Observe · measure agent behavior</option><option value="enforce">Enforce · stop on unsafe or unresolved evidence</option></select></label>
              <label>Baseline suite<select aria-label="Baseline suite" value={baselineId} onChange={e => setBaselineId(e.target.value)}><option value="">No baseline</option>{suites.filter(s => s.id !== suiteId).map(s => <option key={s.id} value={s.id}>{s.id.slice(0, 8)} · {s.status}</option>)}</select></label>
              <label>Hosted budget (USD)<input type="number" min="0" max="10" step="0.001" value={budgetUsd} onChange={e => setBudgetUsd(Number(e.target.value))} /></label>
            </div></details></section>
          <section className="metrics" aria-label="Suite metrics">
            <Metric label="PASSED RUNS" value={`${passed}`} suffix={`/ ${suite?.total ?? 0}`} note="Includes all requested executions" tone="green" />
            <Metric label="BUSINESS VIOLATIONS" value={`${violations}`} note="Required backend checks that failed" tone="red" />
            <Metric label="NEEDS REVIEW" value={`${reviews}`} suffix={`/ ${suite?.total ?? 0}`} note="Unresolved judgments stay unresolved" tone="amber" />
            <Metric label="API SPEND · USD" value={`$${((suite?.spending?.spentMicros ?? 0) / 1000000).toFixed(4)}`} note={`${suite?.spending?.calls ?? 0} hosted calls · ${suite?.spending?.reservedMicros ?? 0} µUSD reserved`} tone="blue" />
          </section>
          <section className="results-section" aria-label="Suite results"><div className="section-heading"><div className="row"><h2>Suite results</h2><span className="count-chip">{completed} / {suite?.total ?? 0}</span>{suite && <Outcome status={suite.status} />}</div>
            <div className="row result-actions">{suite && <><span className="connection-label">{connection}</span>{activeSuite && <button className="small-button" onClick={() => void cancel()}>Cancel suite</button>}
              <a className="small-button" href={`/api/suites/${suite.id}/export`} download>JSON ↓</a><a className="small-button" href={`/api/suites/${suite.id}/export?format=junit`} download>JUnit ↓</a></>}</div></div>
            <div className="results-toolbar"><div className="filter-tabs" aria-label="Filter outcomes">{[{ id: 'all', name: 'All runs' }, { id: 'failed', name: 'Failed' }, { id: 'needs_review', name: 'Review' }, { id: 'passed', name: 'Passed' }].map(f => <button key={f.id} aria-pressed={filter === f.id} className={filter === f.id ? 'active' : ''} onClick={() => setFilter(f.id)}>{f.name}</button>)}</div>
              <label className="suite-select"><span className="sr-only">Saved suite</span><select aria-label="Saved suite" value={suiteId} onChange={e => { setSuiteId(e.target.value); setFilter('all'); }}><option value="">Select a saved suite</option>{suites.map(s => <option key={s.id} value={s.id}>{new Date(s.createdAt).toLocaleString()} · {s.id.slice(0, 8)}</option>)}</select></label></div>
            {!suiteId ? <div className="empty-state"><div className="empty-graphic" aria-hidden="true">↗</div><h3>Find the failure before your customer does.</h3><p>Run the full pack, or start with a committed-timeout case<br className="desktop-break" /> to see a duplicate refund emerge in the ledger.</p><button className="text-button" disabled={launching} onClick={() => { setScenarioId('RF-018'); void launch('RF-018'); }}>Try the duplicate-refund case <span aria-hidden="true">→</span></button></div>
              : !suite ? <div className="empty-state" role="status">Loading suite…</div> : visible.length === 0 ? <div className="empty-state"><h3>{activeSuite ? 'The suite is getting started.' : 'No runs match this filter.'}</h3><p>{activeSuite ? 'Progress will appear here automatically.' : 'Choose another outcome to inspect the suite.'}</p></div>
                : <div className="table-scroll"><table className="results-table"><thead><tr><th>SCENARIO</th><th>REPEAT</th><th>OUTCOME</th><th>REQUIRED CHECKS</th><th>REFUNDS</th><th>JUDGMENT</th></tr></thead><tbody>{visible.map(e => <tr key={e.id} className={executionId === e.id ? 'selected' : ''}>
                  <td><button className="scenario-link" aria-expanded={executionId === e.id} onClick={() => setExecutionId(e.id)}><span className="mono">{e.scenarioId}</span><strong>{e.title}</strong></button></td><td className="mono">{String(e.repetition).padStart(2, '0')}</td><td><Outcome status={e.adjudicatedStatus ?? e.status} />{Boolean(e.reviews?.length) && <small className="human-tag">Human reviewed</small>}</td>
                  <td className="check-summary">{e.checks.filter(c => c.status === 'fail').map(c => c.id).join(', ') || (e.status === 'needs_review' ? 'Semantic review' : e.status === 'running' ? 'In progress' : 'No proven violations')}</td>
                  <td className="mono">{e.result?.refunds.length ?? '—'}</td><td className="judgment-label">{e.result?.judgmentSource === 'fixture-stubs' ? 'Fixture stub' : 'Unverified'}</td></tr>)}</tbody></table></div>}
          </section>
          {comparison && <section className="comparison-panel"><h2>Matched baseline comparison</h2><p>{comparison.pairs.filter(p => p.regression).length} regressions across {comparison.pairs.filter(p => p.previous !== null).length} matched executions. Missing pairs are excluded.</p>{comparison.pairs.map(pair => <p className="mono" key={`${pair.scenarioId}-${pair.repetition}`}>{pair.scenarioId} / {pair.repetition}: {pair.previous ?? 'unmatched'} → {pair.current}{pair.regression ? ' · REGRESSION' : ''}</p>)}</section>}
          {selected && <Inspector key={selected.id} execution={selected} onClose={() => setExecutionId('')} />}
          <p className="workspace-footnote"><span aria-hidden="true">↳</span> Negative fixture agents are designed to fail. A detected mistake is a successful workbench test.</p>
        </>}

        {page === 'scenarios' && <section className="library"><ScenarioEditor scenarios={scenarios} onSaved={refreshCapabilities} /><div className="section-heading"><h2>Authored refund scenarios <span className="count-chip">{scenarios.length}</span></h2><label className="search-label"><span className="sr-only">Search scenarios</span><input aria-label="Search scenarios" placeholder="Search ID, title or family…" value={search} onChange={e => setSearch(e.target.value)} /></label></div>
          <div className="scenario-cards">{filteredScenarios.map(s => <article key={s.id} className="scenario-card"><div className="row spread"><span className="mono scenario-id">{s.id}</span><span className="family-label">{s.family.replaceAll('-', ' ')}</span></div><h3>{s.title}</h3><p>{s.messages[0]}</p><div className="card-details"><span>{s.steps.length} tool calls</span><span>{s.faults.length ? `${s.faults.length} injected faults` : 'No injected faults'}</span></div><div className="row spread"><span className="muted mono">policy {s.policyVersion} · v{s.version}</span><button className="text-button" disabled={launching} onClick={() => { setScenarioId(s.id); void launch(s.id); }}>Run case →</button></div></article>)}</div>
          {!filteredScenarios.length && <p className="empty-state">No scenarios match your search.</p>}</section>}

        {page === 'agents' && <section className="info-card"><span className="eyebrow">AVAILABLE AGENTS</span><h2>Agent behavior and tool permissions</h2><p>All agent actions run in the isolated mock shop. Each profile defines its system prompt, tools and behavior settings.</p><AgentEditor providers={providers} onSaved={refreshCapabilities} />{agents.map(agent => <article className="provider-row" key={agent.id}><div><strong>{agent.name}</strong><p>{agent.description}</p><span className="mode-badge">{agent.kind}</span><pre>{JSON.stringify(agent, null, 2)}</pre></div><button className="small-button" onClick={() => { setAgentId(agent.id); setPage('runs'); }}>Select agent</button></article>)}<button className="text-button" onClick={() => setPage('settings')}>Configure another provider →</button></section>}

        {page === 'judges' && <ReviewWorkspace suite={suite} onReviewed={async () => { if (suiteId) setSuite(await request<SuiteDetail>(`/api/suites/${suiteId}`)); }} />}

        {page === 'settings' && <><section className="info-card"><span className="eyebrow">WORKSPACE BOUNDARIES</span><h2>Local by default.</h2><dl className="settings-list"><div><dt>Service binding</dt><dd className="mono">127.0.0.1</dd></div><div><dt>Storage</dt><dd>Local SQLite + artifacts</dd></div><div><dt>Cloud inference</dt><dd>{providers.some(p => p.enabled && p.networkMode === 'hybrid') ? 'Explicit roles configured · suite budget required' : 'Disabled'}</dd></div><div><dt>Browser session</dt><dd>HttpOnly · 12 hours</dd></div><div><dt>Currency / policy</dt><dd>AUD integer cents / p1</dd></div></dl></section><ProviderSettings providers={providers} onSaved={refreshCapabilities} /></>}
        </>}
      </main><footer className="app-footer"><span>AgentWindTunnel</span><span>Evidence over eloquence.</span><span className="mono">LOCAL / v0.1</span></footer>
    </div>
  </div>;
}

function Metric({ label, value, suffix, note, tone }: { label: string; value: string; suffix?: string; note: string; tone: string }) {
  return <div className={`metric ${tone}`}><p className="eyebrow"><span />{label}</p><div className="metric-value">{value}<span>{suffix}</span></div><p className="metric-note">{note}</p></div>;
}
