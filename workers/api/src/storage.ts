// All security mutations are synchronous SQLite transactions. No external await inside a transaction.
export class Records {
  constructor(private storage: DurableObjectStorage) {
    storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS records (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
    );
  }
  get<T>(key: string): T | undefined {
    const rows = this.storage.sql
      .exec<{ value: string }>('SELECT value FROM records WHERE key=?', key)
      .toArray();
    return rows.length ? JSON.parse(rows[0].value) : undefined;
  }
  put(key: string, value: unknown): void {
    this.storage.sql.exec(
      'INSERT INTO records(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      key,
      JSON.stringify(value),
    );
  }
  all<T>(prefix: string): { key: string; value: T }[] {
    return this.storage.sql
      .exec<{ key: string; value: string }>(
        'SELECT key,value FROM records WHERE key LIKE ?',
        prefix + '%',
      )
      .toArray()
      .map((r) => ({ key: r.key, value: JSON.parse(r.value) }));
  }
  delete(key: string): void {
    this.storage.sql.exec('DELETE FROM records WHERE key=?', key);
  }
  atomic<T>(fn: () => T): T {
    return this.storage.transactionSync(fn);
  }
}
