import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { Suite, SuiteEvent } from '../../packages/contracts/api.ts';

export class SuiteStore {
  private db: DatabaseSync;
  private workerToken = randomUUID();
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS suites (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, document TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS suite_events (suite_id TEXT NOT NULL, sequence INTEGER NOT NULL, document TEXT NOT NULL,
        PRIMARY KEY(suite_id, sequence)) STRICT;
      CREATE TABLE IF NOT EXISTS artifacts (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, filename TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS worker_lock (id INTEGER PRIMARY KEY CHECK(id = 1), token TEXT NOT NULL, pid INTEGER NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS documents (owner_id TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL, document TEXT NOT NULL,
        PRIMARY KEY(owner_id, kind, id)) STRICT;
      CREATE TABLE IF NOT EXISTS spending (id TEXT PRIMARY KEY, suite_id TEXT NOT NULL, reserved INTEGER NOT NULL, actual INTEGER, state TEXT NOT NULL) STRICT;`);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const lock = this.db.prepare('SELECT pid FROM worker_lock WHERE id = 1').get();
      if (lock) {
        let alive = true;
        try { process.kill(Number(lock.pid), 0); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') alive = false; }
        if (alive) throw new Error('Another workbench owns this database; stop it or use a different AW_DATA_DIR');
      }
      this.db.prepare('INSERT OR REPLACE INTO worker_lock VALUES (1, ?, ?)').run(this.workerToken, process.pid);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); this.db.close(); throw error; }
  }
  list(ownerId?: string): Suite[] {
    const rows = ownerId === undefined ? this.db.prepare('SELECT document FROM suites ORDER BY rowid DESC').all() :
      this.db.prepare('SELECT document FROM suites WHERE owner_id = ? ORDER BY rowid DESC').all(ownerId);
    return rows.map(row => JSON.parse(row.document as string) as Suite);
  }
  get(id: string, ownerId: string): Suite | undefined {
    const row = this.db.prepare('SELECT document FROM suites WHERE id = ? AND owner_id = ?').get(id, ownerId);
    return row ? JSON.parse(row.document as string) as Suite : undefined;
  }
  save(suite: Suite, executionId?: string): SuiteEvent {
    suite.updatedAt = new Date().toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO suites (id, owner_id, document) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET document = excluded.document')
        .run(suite.id, suite.ownerId, JSON.stringify(suite));
      const row = this.db.prepare('SELECT COALESCE(MAX(sequence), 0) AS sequence FROM suite_events WHERE suite_id = ?').get(suite.id)!;
      const event: SuiteEvent = { id: Number(row.sequence) + 1, type: 'progress', data: {
        status: suite.status, total: suite.total, completed: suite.executions.filter(e => e.status !== 'running').length,
        ...(executionId ? { executionId } : {}),
      } };
      this.db.prepare('INSERT INTO suite_events VALUES (?, ?, ?)').run(suite.id, event.id, JSON.stringify(event));
      this.db.exec('COMMIT');
      return event;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  events(id: string, after = 0): SuiteEvent[] {
    return this.db.prepare('SELECT document FROM suite_events WHERE suite_id = ? AND sequence > ? ORDER BY sequence')
      .all(id, after).map(row => JSON.parse(row.document as string));
  }
  addArtifact(id: string, ownerId: string, filename: string): void {
    this.db.prepare('INSERT INTO artifacts VALUES (?, ?, ?)').run(id, ownerId, filename);
  }
  artifact(id: string, ownerId: string): string | undefined {
    return this.db.prepare('SELECT filename FROM artifacts WHERE id = ? AND owner_id = ?').get(id, ownerId)?.filename as string | undefined;
  }
  documents<T>(owner: string, kind: string): T[] {
    return this.db.prepare('SELECT document FROM documents WHERE owner_id = ? AND kind = ? ORDER BY rowid').all(owner, kind).map(row => JSON.parse(row.document as string));
  }
  put(owner: string, kind: string, id: string, value: unknown): void {
    this.db.prepare('INSERT INTO documents VALUES (?, ?, ?, ?) ON CONFLICT(owner_id,kind,id) DO UPDATE SET document=excluded.document')
      .run(owner, kind, id, JSON.stringify(value));
  }
  reserve(suiteId: string, limit: number, amount: number): string {
    if (!Number.isSafeInteger(limit) || limit <= 0 || !Number.isSafeInteger(amount) || amount <= 0) throw new Error('Unknown price or zero budget');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const total = Number(this.db.prepare('SELECT COALESCE(SUM(COALESCE(actual,reserved)),0) AS total FROM spending WHERE suite_id = ?').get(suiteId)!.total);
      if (amount > limit - total) throw new Error('Suite cloud budget exhausted');
      const id = randomUUID();
      this.db.prepare('INSERT INTO spending VALUES (?, ?, ?, NULL, ?)').run(id, suiteId, amount, 'reserved');
      this.db.exec('COMMIT'); return id;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  settle(id: string, actual: number): void {
    if (!Number.isSafeInteger(actual) || actual < 0) throw new Error('Invalid provider charge');
    if (this.db.prepare('UPDATE spending SET actual = ?, state = ? WHERE id = ? AND state = ? AND reserved >= ?')
      .run(actual, 'settled', id, 'reserved', actual).changes !== 1) throw new Error('Charge exceeds reservation');
  }
  spending(suiteId: string) {
    const rows = this.db.prepare('SELECT reserved, actual, state FROM spending WHERE suite_id = ?').all(suiteId);
    return { reservedMicros: rows.filter(r => r.actual === null).reduce((sum, r) => sum + Number(r.reserved), 0),
      spentMicros: rows.reduce((sum, r) => sum + Number(r.actual ?? 0), 0), calls: rows.length };
  }
  close(): void {
    this.db.prepare('DELETE FROM worker_lock WHERE token = ?').run(this.workerToken);
    this.db.close();
  }
}
