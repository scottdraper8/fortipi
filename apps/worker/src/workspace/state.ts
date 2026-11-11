/** Application metadata only. Never inspect or modify Computer's private SQL tables. */
export class State {
  readonly storage: DurableObjectStorage;
  constructor(storage: DurableObjectStorage) {
    this.storage = storage;
    storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS fp_ws_record (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
    );
  }
  get<T>(key: string): T | undefined {
    const row = this.storage.sql
      .exec<{ value: string }>("SELECT value FROM fp_ws_record WHERE key=?", key)
      .toArray()[0];
    return row ? (JSON.parse(row.value) as T) : undefined;
  }
  put(key: string, value: unknown): void {
    this.storage.sql.exec(
      "INSERT INTO fp_ws_record(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      key,
      JSON.stringify(value),
    );
  }
  delete(key: string): void {
    this.storage.sql.exec("DELETE FROM fp_ws_record WHERE key=?", key);
  }
  page<T>(prefix: string, after = "", limit = 100): { key: string; value: T }[] {
    return this.storage.sql
      .exec<{ key: string; value: string }>(
        "SELECT key,value FROM fp_ws_record WHERE key>=? AND key<? AND key>? ORDER BY key LIMIT ?",
        prefix,
        `${prefix}\uffff`,
        after,
        Math.min(100, limit),
      )
      .toArray()
      .map((row) => ({ key: row.key, value: JSON.parse(row.value) as T }));
  }
  transaction<T>(work: () => T): T {
    return this.storage.transactionSync(work);
  }
  get bytes(): number {
    return this.storage.sql.databaseSize;
  }
}
