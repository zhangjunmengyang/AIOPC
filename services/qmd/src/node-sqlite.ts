import { DatabaseSync } from "node:sqlite";
import type { Database, SQLiteValue, Statement } from "./db.js";

/** Adapter for the SQLite bundled with Node/Electron on the AIOPC runner. */
export class NodeSqliteDatabase implements Database {
  private readonly db: DatabaseSync;
  private savepoint = 0;

  constructor(path: string) {
    this.db = new DatabaseSync(path, { allowExtension: true });
    this.db.enableLoadExtension(false);
  }

  get inTransaction(): boolean {
    return this.db.isTransaction;
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  prepare(sql: string): Statement {
    const statement = this.db.prepare(sql);
    return {
      run: (...params) => {
        const result = statement.run(...params);
        return { changes: Number(result.changes), lastInsertRowid: result.lastInsertRowid };
      },
      get: <T>(...params: SQLiteValue[]) => statement.get(...params) as T | undefined,
      all: <T>(...params: SQLiteValue[]) => statement.all(...params) as T[],
      iterate: <T>(...params: SQLiteValue[]) => statement.iterate(...params) as IterableIterator<T>,
    };
  }

  loadExtension(path: string): void {
    this.db.enableLoadExtension(true);
    try {
      this.db.loadExtension(path);
    } finally {
      this.db.enableLoadExtension(false);
    }
  }

  transaction<T extends (...args: SQLiteValue[]) => unknown>(fn: T): T & { immediate: T } {
    const run = (immediate: boolean, args: SQLiteValue[]) => {
      const savepoint = this.db.isTransaction ? `qmd_${++this.savepoint}` : undefined;
      this.db.exec(savepoint ? `SAVEPOINT ${savepoint}` : immediate ? "BEGIN IMMEDIATE" : "BEGIN");
      try {
        const result = fn(...args);
        this.db.exec(savepoint ? `RELEASE ${savepoint}` : "COMMIT");
        return result;
      } catch (error) {
        this.db.exec(savepoint ? `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}` : "ROLLBACK");
        throw error;
      }
    };
    return Object.assign(
      ((...args: SQLiteValue[]) => run(false, args)) as T,
      { immediate: ((...args: SQLiteValue[]) => run(true, args)) as T },
    );
  }

  close(): void {
    this.db.close();
  }
}
