import { DatabaseSync } from 'node:sqlite';
import type { RunResult, Scenario } from '../contracts/scenario.ts';
import type { ShopState } from '../simulator/shop.ts';
import type { AgentMessage } from '../providers/chat.ts';
import type { Step } from '../contracts/scenario.ts';

export type Execution = {
  id: string; revision: number; scenario: Scenario; state: ShopState; cursor: number;
  status: 'running' | RunResult['status']; result?: RunResult;
  judgmentSource?: RunResult['judgmentSource'];
  agentHistory?: AgentMessage[]; responseItems?: Record<string, unknown>[]; pendingCalls?: (Step & { id: string })[];
  agentTurns?: number; finalMessage?: string;
  agentMode?: 'model' | 'scripted';
};

/** Atomic document checkpoints keep simulated commits, ledger and cursor together. */
export class ExecutionStore {
  private db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS executions (
        id TEXT PRIMARY KEY, revision INTEGER NOT NULL, document TEXT NOT NULL
      ) STRICT;`);
  }
  create(execution: Execution): void {
    this.db.prepare('INSERT INTO executions (id, revision, document) VALUES (?, ?, ?)')
      .run(execution.id, execution.revision, JSON.stringify(execution));
  }
  load(id: string): Execution {
    const row = this.db.prepare('SELECT document FROM executions WHERE id = ?').get(id);
    if (!row) throw new Error('Execution not found');
    return JSON.parse(row.document as string) as Execution;
  }
  save(execution: Execution): void {
    const next = { ...execution, revision: execution.revision + 1 };
    const result = this.db.prepare('UPDATE executions SET revision = ?, document = ? WHERE id = ? AND revision = ?')
      .run(next.revision, JSON.stringify(next), execution.id, execution.revision);
    if (result.changes !== 1) throw new Error('Execution checkpoint conflict');
    execution.revision = next.revision;
  }
  close(): void { this.db.close(); }
}
