import { createHash, randomUUID } from 'node:crypto';
import { bounded } from '../providers/deadline.ts';

export type Verdict = 'safe' | 'suspicious' | 'unavailable';
export type Guard = (span: { text: string; source: string; eventId: string; offset: number; signal?: AbortSignal }) => Promise<Verdict>;
export type EvidenceRecord = {
  id: string; source: string; rawPayload: string; hash: string; reviewRequired: boolean;
  guardCalls: number; coverageComplete: boolean; spans: { offset: number; verdict: Verdict }[];
  exposure: 'isolated-subject' | 'inert-display';
};

/** Advisory detectors never receive capabilities or references to protected state. */
export class IsolationBoundary {
  private host = Object.freeze({ policyVersion: 'p1', networkMode: 'local', secretRef: 'OS_CREDENTIAL_ONLY' });
  private records = new Map<string, EvidenceRecord>();
  private guard: Guard;
  readonly deniedOperations: string[] = [];
  constructor(guard: Guard) { this.guard = guard; }
  snapshot() { return structuredClone(this.host); }
  authorizeHostOperation(operation: string): boolean {
    // Evidence processing has no control-plane capability, even after a safe verdict.
    this.deniedOperations.push(operation);
    return false;
  }
  async ingest(payload: string, source: string, mode: 'workbench' | 'webapp'): Promise<EvidenceRecord> {
    if (typeof payload !== 'string' || Buffer.byteLength(payload) > 1024 * 1024) throw new Error('Evidence size limit');
    const id = randomUUID();
    const spans: EvidenceRecord['spans'] = [];
    let offset = 0;
    const signal = AbortSignal.timeout(10000);
    for (let index = 0; index < 32 && offset < Math.max(1, payload.length); index++) {
      const text = payload.slice(offset, offset + 2048);
      let verdict: Verdict = 'unavailable';
      try { verdict = await bounded(this.guard({ text, source, eventId: id, offset, signal }), signal); } catch { /* Fail closed. */ }
      if (!['safe', 'suspicious', 'unavailable'].includes(verdict)) verdict = 'unavailable';
      spans.push({ offset, verdict });
      if (signal.aborted) break;
      if (offset + 2048 >= payload.length) { offset = payload.length; break; }
      offset += 1920;
    }
    const coverageComplete = offset >= payload.length;
    const record: EvidenceRecord = { id, source, rawPayload: payload,
      hash: createHash('sha256').update(payload).digest('hex'), reviewRequired: !coverageComplete || spans.some(s => s.verdict !== 'safe'),
      guardCalls: spans.length, coverageComplete, spans, exposure: mode === 'workbench' ? 'isolated-subject' : 'inert-display' };
    this.records.set(id, structuredClone(record));
    return record;
  }
}
