import { useState } from 'react';
import type { ExecutionView } from '../../../packages/contracts/api.ts';

export function Outcome({ status }: { status: string }) {
  const labels: Record<string, string> = { passed: 'Pass', failed: 'Fail', needs_review: 'Review', error: 'Error',
    cancelled: 'Cancelled', running: 'Running', queued: 'Queued', completed: 'Completed', pass: 'Pass', fail: 'Fail' };
  return <span className={`outcome ${status}`}><span aria-hidden="true">{['passed', 'pass'].includes(status) ? '✓' : ['failed', 'fail', 'error'].includes(status) ? '×' : '·'}</span> {labels[status] ?? status}</span>;
}

/** Untrusted content is always a React text child; no HTML/Markdown interpretation. */
export function Inspector({ execution, onClose }: { execution: ExecutionView; onClose?: () => void }) {
  const [tab, setTab] = useState('conversation');
  const [highlight, setHighlight] = useState<string | undefined>();
  const tabs = ['conversation', 'checks', 'state'];
  const evidenceOperations = new Set(execution.events.filter(event => {
    const data = event.data as { error?: string; kind?: string } | undefined;
    if (!highlight) return false;
    if (highlight === 'tool_schema') return ['invalid_arguments', 'idempotency_conflict'].includes(data?.error ?? '');
    if (highlight === 'retry_limit') return event.type === 'fault' && ['timeout', 'rate_limit'].includes(data?.kind ?? '');
    if (event.type === 'refund_committed') return true;
    const errors: Record<string, string[]> = { amount: ['amount', 'unsafe_total'], policy: ['policy'],
      identity: ['unauthorized'], ownership: ['unauthorized'], target_order: ['unauthorized'] };
    return (errors[highlight] ?? []).includes(data?.error ?? '');
  }).map(event => event.operationId));
  return <section className="inspector" aria-label="Run inspector">
    <div className="inspector-heading"><div><p className="eyebrow">RUN INSPECTOR <span className="mono">/ {execution.scenarioId}</span></p>
      <h2>{execution.title}</h2><p className="muted mono">Repeat {execution.repetition} · {execution.result?.judgmentSource === 'fixture-stubs' ? 'Synthetic fixture judgments' : 'Semantics unverified'}</p></div>
      <div className="row"><Outcome status={execution.status} />{onClose && <button className="icon-button" aria-label="Close inspector" onClick={onClose}>×</button>}</div>
    </div>
    <div className="inspector-tabs" role="tablist" aria-label="Inspector panels">{tabs.map(name => <button key={name} role="tab" aria-selected={tab === name} tabIndex={tab === name ? 0 : -1}
      aria-controls={`panel-${name}`} id={`tab-${name}`} onClick={() => setTab(name)} onKeyDown={event => {
        const index = tabs.indexOf(name);
        const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : -1;
        if (next < 0) return;
        event.preventDefault(); setTab(tabs[next]);
        document.getElementById(`tab-${tabs[next]}`)?.focus();
      }}>{name === 'state' ? 'Before → after' : name[0].toUpperCase() + name.slice(1)}</button>)}</div>
    <div className="inspector-columns">
      <section id="panel-conversation" role="tabpanel" aria-labelledby="tab-conversation" className={`inspect-panel conversation-panel ${tab === 'conversation' ? 'active' : ''}`}>
        <h3>Conversation & tools <span>{execution.events.filter(e => e.type === 'tool_called').length} calls</span></h3>
        {execution.messages.map((message, index) => <div className="message" key={index}><span className="event-label">CUSTOMER</span><p className="untrusted-text">{message}</p></div>)}
        <div className="timeline">{execution.events.filter(e => !['execution_started', 'execution_finished', 'agent_message'].includes(e.type)).map(event =>
          <details key={event.id} className={`event ${highlight && event.operationId && evidenceOperations.has(event.operationId) ? 'highlight' : ''}`}>
            <summary><span className="event-number">{String(event.sequence).padStart(2, '0')}</span><span>{event.type.replaceAll('_', ' ')}</span><span className="event-glyph" aria-hidden="true">+</span></summary>
            <pre className="untrusted-text">{JSON.stringify(event.data, null, 2)}</pre>
          </details>)}</div>
        <div className="message agent-message"><span className="event-label">AGENT · FINAL RESPONSE</span><p className="untrusted-text">{execution.finalMessage}</p></div>
      </section>
      <section id="panel-checks" role="tabpanel" aria-labelledby="tab-checks" className={`inspect-panel checks-panel ${tab === 'checks' ? 'active' : ''}`}>
        <h3>Assertions <span>{execution.checks.length} checks</span></h3>
        <div className="check-list">{execution.checks.map(check => <button key={check.id} className={`check ${highlight === check.id ? 'selected' : ''}`}
          aria-pressed={highlight === check.id} onClick={() => { setHighlight(highlight === check.id ? undefined : check.id); }}>
          <span className="mono">{check.id}</span><Outcome status={check.status} /></button>)}</div>
        <div className="panel-note"><span className="event-label">JUDGMENT SOURCE</span><p>{execution.result?.judgmentSource === 'fixture-stubs'
          ? 'Synthetic fixture answers. No model was called. These results do not measure model accuracy.'
          : execution.result?.judgmentSource === 'injected-provider' ? 'Provider diagnostics are available in the timeline. Uncalibrated judgments remain human-gated.' : 'No semantic provider supplied a verified judgment. Required semantics remain in review.'}</p>
          {highlight && <p>Highlighted tool events and refund rows supply the backend evidence. Attempted violations can fail even when a write was blocked.</p>}</div>
        {execution.reviews?.map(review => <div className="panel-note" key={review.id}><span className="event-label">HUMAN REVIEW · {review.checkId}</span><p>{review.status}: {review.note}</p><p>{new Date(review.createdAt).toLocaleString()}</p></div>)}
      </section>
      <section id="panel-state" role="tabpanel" aria-labelledby="tab-state" className={`inspect-panel state-panel ${tab === 'state' ? 'active' : ''}`}>
        <h3>Before → after <span>AUD cents</span></h3>
        <div className="state-verification"><span>Identity verified</span><span className="mono">{String(execution.before.verified)} → {String(execution.after.verified)}</span></div>
        {execution.before.orders.map(before => {
          const after = execution.after.orders.find(o => o.id === before.id)!;
          const changed = before.refunded !== after.refunded;
          return <div className={`state-order ${changed ? 'changed' : ''}`} key={before.id}><div className="row spread"><strong className="mono">{before.id}</strong><span className="state-tag">{changed ? 'CHANGED' : 'UNCHANGED'}</span></div>
            <dl><div><dt>Refunded</dt><dd>{before.refunded.toLocaleString()} <span>→</span> {after.refunded.toLocaleString()}</dd></div>
              <div><dt>Remaining eligible</dt><dd>{before.eligibleAmount.toLocaleString()} <span>→</span> {after.eligibleAmount.toLocaleString()}</dd></div>
              <div><dt>Paid</dt><dd>{before.paid.toLocaleString()}</dd></div></dl></div>;
        })}
        <div className="panel-note"><span className="event-label">COMMITTED REFUNDS</span><p className="big-number">{execution.result?.refunds.length ?? 0}</p><p>Recorded in the isolated shop ledger. No real payments are connected.</p></div>
      </section>
    </div>
  </section>;
}
