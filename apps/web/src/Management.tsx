import { useEffect, useState } from 'react';
import { request } from './api.ts';
import type { ProviderConfig } from '../../../packages/contracts/providers.ts';
import type { Scenario } from '../../../packages/contracts/scenario.ts';
import type { SuiteDetail } from '../../../packages/contracts/api.ts';

export function ProviderSettings({ providers, onSaved }: { providers: ProviderConfig[]; onSaved: () => Promise<void> }) {
  const [protocol, setProtocol] = useState<ProviderConfig['protocol']>('ollama');
  const [name, setName] = useState('Local Ollama');
  const [id, setId] = useState('local-ollama');
  const [baseUrl, setBaseUrl] = useState('http://127.0.0.1:11434');
  const [model, setModel] = useState('qwen2.5-coder:7b');
  const [revision, setRevision] = useState('qwen2.5-coder:7b');
  const [tokenizer, setTokenizer] = useState('unverified');
  const [context, setContext] = useState(4096);
  const [mode, setMode] = useState<ProviderConfig['networkMode']>('local');
  const [consent, setConsent] = useState(false);
  const [roles, setRoles] = useState<ProviderConfig['roles']>(['agent']);
  const [secretRef, setSecretRef] = useState('');
  const [inputPrice, setInputPrice] = useState('');
  const [outputPrice, setOutputPrice] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true); setMessage('');
    try {
      await request('/api/providers', { method: 'POST', body: JSON.stringify({ id, name, protocol, baseUrl, model, modelRevision: revision,
        tokenizerRevision: tokenizer, contextLimit: context, roles, networkMode: mode, cloudConsent: consent,
        ...(protocol === 'systemone' ? { engine: mode === 'hybrid' ? 'jev' : 'laya' } : {}),
        ...(secretRef ? { secretRef } : {}),
        ...(mode === 'hybrid' ? { prices: { input: Math.round(Number(inputPrice) * 1000000), output: Math.round(Number(outputPrice) * 1000000) } } : {}),
      }) });
      await onSaved(); setMessage('Provider saved. Probe availability before running it. Automatic semantic acceptance remains disabled.');
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Provider save failed'); }
    finally { setBusy(false); }
  }
  async function probe(provider: ProviderConfig) {
    setBusy(true);
    try { setMessage(JSON.stringify(await request('/api/providers/test', { method: 'POST', body: JSON.stringify({ id: provider.id }) }), null, 2)); }
    catch (error) { setMessage(error instanceof Error ? error.message : 'Probe failed'); }
    finally { setBusy(false); }
  }
  return <section className="info-card management-card"><span className="eyebrow">PROVIDER CONNECTIONS</span><h2>Explicit roles. Local defaults.</h2>
    <p>Endpoints are approved explicitly and checked again at connection time. Hosted roles require consent, configured pricing, redaction, and a per-suite budget. Credentials are referenced through server environment variables.</p>
    <div className="provider-list">{providers.map(provider => <article className="provider-row" key={provider.id}><div><strong>{provider.name}</strong><p className="mono">{provider.model} · {provider.protocol} · {provider.networkMode}</p><p>{provider.roles.join(', ')} · {provider.enabled ? 'Enabled' : 'Disabled'}</p></div><button className="small-button" disabled={busy} onClick={() => void probe(provider)}>Probe availability</button><button className="small-button" onClick={async () => { try { await request('/api/providers', { method: 'POST', body: JSON.stringify({ ...provider, enabled: !provider.enabled }) }); await onSaved(); } catch (e) { setMessage(String(e)); } }}>{provider.enabled ? 'Disable' : 'Enable'}</button></article>)}</div>
    <form onSubmit={event => { event.preventDefault(); void save(); }} className="management-form">
      <div className="management-grid"><label>Provider ID<input required value={id} onChange={e => setId(e.target.value)} /></label><label>Display name<input required value={name} onChange={e => setName(e.target.value)} /></label>
        <label>Protocol<select value={protocol} onChange={e => setProtocol(e.target.value as ProviderConfig['protocol'])}><option value="ollama">Local Ollama</option><option value="systemone">System One (Laya / Jev)</option><option value="chat-completions">Chat Completions</option><option value="openai-responses">OpenAI Responses</option></select></label>
        <label>Endpoint origin<input required value={baseUrl} onChange={e => setBaseUrl(e.target.value)} /></label><label>Model ID<input required value={model} onChange={e => setModel(e.target.value)} /></label><label>Model revision / local digest<input required value={revision} onChange={e => setRevision(e.target.value)} /></label>
        <label>Tokenizer revision<input required value={tokenizer} onChange={e => setTokenizer(e.target.value)} /></label><label>Context limit<input required type="number" min="128" max="131072" value={context} onChange={e => setContext(Number(e.target.value))} /></label>
        <label>Network mode<select value={mode} onChange={e => setMode(e.target.value as ProviderConfig['networkMode'])}><option value="local">Local only</option><option value="lan">Local + LAN</option><option value="hybrid">Explicit hosted / hybrid</option></select></label><label>Server secret reference<input placeholder="AW_JEV_KEY (never paste the key)" value={secretRef} onChange={e => setSecretRef(e.target.value)} /></label>
      </div><fieldset><legend>Allowed roles</legend>{(['agent', 'judge', 'injection-guard'] as const).map(role => <label className="checkbox-label" key={role}><input type="checkbox" checked={roles.includes(role)} onChange={e => setRoles(e.target.checked ? [...roles, role] : roles.filter(r => r !== role))} />{role}</label>)}</fieldset>
      {mode === 'hybrid' && <div className="hosted-consent"><label className="checkbox-label"><input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} />I explicitly allow this provider to receive redacted data for the selected roles.</label><div className="management-grid"><label>Input USD / million tokens<input type="number" min="0.000001" step="any" required value={inputPrice} onChange={e => setInputPrice(e.target.value)} /></label><label>Output USD / million tokens<input type="number" min="0.000001" step="any" required value={outputPrice} onChange={e => setOutputPrice(e.target.value)} /></label></div><p>Prices are supplied by you. A zero suite budget blocks hosted dispatch. Jev stays review-gated until exact preflight is available.</p></div>}
      <button className="primary-button" disabled={busy || !roles.length} type="submit">{busy ? 'Working…' : 'Save provider'}</button>
    </form>{message && <pre className="operation-message" role="status">{message}</pre>}
  </section>;
}

export function ScenarioEditor({ scenarios, onSaved }: { scenarios: Scenario[]; onSaved: () => Promise<void> }) {
  const [source, setSource] = useState(scenarios[0]?.id ?? '');
  const [title, setTitle] = useState('');
  const [messages, setMessages] = useState('');
  const [steps, setSteps] = useState('');
  const [finalMessage, setFinalMessage] = useState('');
  const [initial, setInitial] = useState('');
  const [faults, setFaults] = useState('[]');
  const [notice, setNotice] = useState('');
  useEffect(() => { const item = scenarios.find(s => s.id === source); if (item) { setTitle(item.title + ' — copy'); setMessages(JSON.stringify(item.messages, null, 2)); setSteps(JSON.stringify(item.steps, null, 2)); setFinalMessage(item.finalMessage); setInitial(JSON.stringify(item.initial, null, 2)); setFaults(JSON.stringify(item.faults, null, 2)); } }, [source, scenarios]);
  return <details className="scenario-editor"><summary>Create an immutable scenario copy</summary><form className="management-form" onSubmit={async event => {
    event.preventDefault();
    try { await request('/api/scenarios', { method: 'POST', body: JSON.stringify({ sourceId: source, title, messages: JSON.parse(messages), steps: JSON.parse(steps), initial: JSON.parse(initial), faults: JSON.parse(faults), finalMessage }) }); setNotice('New version saved. Existing suites retain their original scenario.'); await onSaved(); }
    catch (error) { setNotice(error instanceof Error ? error.message : 'Invalid scenario'); }
  }}><p>Copy an authored case and edit its isolated shop state, messages, actions, faults and final response. Trusted policy revision, judge/guard metadata, and provider permissions stay inherited from the source.</p>
    <label>Source scenario<select aria-label="Source scenario" value={source} onChange={e => setSource(e.target.value)}>{scenarios.map(s => <option key={s.id} value={s.id}>{s.id} · {s.title}</option>)}</select></label>
    <label>Copy title<input required minLength={6} value={title} onChange={e => setTitle(e.target.value)} /></label><label>Customer messages (JSON array)<textarea rows={5} value={messages} onChange={e => setMessages(e.target.value)} /></label><label>Tool actions (JSON array)<textarea rows={8} value={steps} onChange={e => setSteps(e.target.value)} /></label><label>Final agent response<textarea rows={3} value={finalMessage} onChange={e => setFinalMessage(e.target.value)} /></label>
    <label>Initial shop state (JSON)<textarea rows={8} value={initial} onChange={e => setInitial(e.target.value)} /></label><label>Fault schedule (JSON array)<textarea rows={5} value={faults} onChange={e => setFaults(e.target.value)} /></label>
    <button className="primary-button" type="submit">Save scenario copy</button>{notice && <p role="status">{notice}</p>}
  </form></details>;
}

export function ReviewWorkspace({ suite, onReviewed }: { suite?: SuiteDetail; onReviewed: () => Promise<void> }) {
  const [executionId, setExecutionId] = useState('');
  const [checkId, setCheckId] = useState('message_truth');
  const [status, setStatus] = useState('needs_review');
  const [note, setNote] = useState('');
  const [notice, setNotice] = useState('');
  const [summary, setSummary] = useState<{ reviewed: number; matrix: Record<string, number> }>();
  const execution = suite?.executions.find(e => e.id === executionId) ?? suite?.executions[0];
  async function refreshSummary() { setSummary(await request('/api/reviews')); }
  useEffect(() => { void refreshSummary().catch(() => {}); }, []);
  return <section className="info-card management-card"><span className="eyebrow">APPEND-ONLY HUMAN ADJUDICATION</span><h2>Review the evidence. Preserve the original.</h2><p>Human labels are stored alongside original judgments. They can resolve semantic uncertainty, but cannot erase identity, ownership, duplicate-refund, or other deterministic failures.</p>
    {execution ? <form className="management-form" onSubmit={async event => {
      event.preventDefault();
      try { await request(`/api/executions/${execution.id}/reviews`, { method: 'POST', body: JSON.stringify({ checkId, status, note }) }); setNotice('Review appended. Original checks are unchanged.'); await onReviewed(); await refreshSummary(); }
      catch (error) { setNotice(error instanceof Error ? error.message : 'Review failed'); }
    }}><label>Execution<select aria-label="Review execution" value={execution.id} onChange={e => setExecutionId(e.target.value)}>{suite!.executions.map(e => <option key={e.id} value={e.id}>{e.scenarioId} · repeat {e.repetition} · {e.title}</option>)}</select></label>
      <div className="management-grid"><label>Semantic check<select value={checkId} onChange={e => setCheckId(e.target.value)}><option value="message_truth">Message truth</option><option value="injection">Injection risk</option></select></label><label>Human label<select value={status} onChange={e => setStatus(e.target.value)}><option value="needs_review">Insufficient evidence / review</option><option value="pass">Pass</option><option value="fail">Fail</option></select></label></div>
      <div className="review-evidence"><p className="eyebrow">AGENT RESPONSE</p><p>{execution.finalMessage}</p><pre>{JSON.stringify({ refunds: execution.result?.refunds, checks: execution.checks }, null, 2)}</pre></div>
      <label>Reviewer note<textarea rows={3} maxLength={2000} value={note} onChange={e => setNote(e.target.value)} /></label><button className="primary-button" type="submit">Append review</button>{notice && <p role="status">{notice}</p>}
      <p className="muted">Original outcome: {execution.status} · Human-adjudicated outcome: {execution.adjudicatedStatus ?? execution.status}</p>
      {execution.reviews?.map(review => <div className="review-history" key={review.id}><strong>{review.checkId}: {review.status}</strong><p>{review.note}</p><small>{new Date(review.createdAt).toLocaleString()}</small></div>)}
    </form> : <p className="panel-note">Select or launch a suite to review its executions.</p>}
    <div className="panel-note"><p>{summary?.reviewed ?? 0} recorded review labels. Automatic acceptance remains disabled.</p><p>These operational labels are not a held-out accuracy benchmark.</p><pre>{JSON.stringify(summary?.matrix ?? {}, null, 2)}</pre></div>
  </section>;
}
