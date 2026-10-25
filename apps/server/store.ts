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
      CREATE TABLE IF NOT EXISTS worker_lock (id INTEGER PRIMARY KEY CHECK(id = 1), token TEXT NOT NULL, pid INTEGER NOT NULL) STRICT;`);
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
  close(): void {
    this.db.prepare('DELETE FROM worker_lock WHERE token = ?').run(this.workerToken);
    this.db.close();
  }
}
