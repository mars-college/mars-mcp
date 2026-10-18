import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, openSync, closeSync, lstatSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const now = (): number => Math.floor(Date.now() / 1000);
export const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
export const secret = (): string => randomBytes(32).toString('base64url');

/** Local, private state. Callers must hash credential keys before storing them. */
export class AuthStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') {
      path = resolve(path);
      const parent = dirname(path);
      mkdirSync(parent, { recursive: true, mode: 0o700 });
      const parentInfo = lstatSync(parent);
      if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink() || (parentInfo.mode & 0o077) !== 0) {
        throw new Error('Auth database requires a dedicated private directory (mode 0700)');
      }
      try {
        const fd = openSync(path, 'wx', 0o600);
        closeSync(fd);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) {
        throw new Error('Auth database must be a regular file');
      }
      chmodSync(path, 0o600);
    }
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = DELETE; PRAGMA secure_delete = ON;');
    this.db.exec('CREATE TABLE IF NOT EXISTS auth_state (kind TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, expires_at INTEGER NOT NULL, PRIMARY KEY (kind, key)); CREATE INDEX IF NOT EXISTS auth_expiry ON auth_state(expires_at)');
    this.cleanup();
  }

  private cleanup(): void {
    this.db.prepare('DELETE FROM auth_state WHERE expires_at <= ?').run(now());
  }

  get<T>(kind: string, key: string): T | undefined {
    const row = this.db.prepare('SELECT value FROM auth_state WHERE kind = ? AND key = ? AND expires_at > ?').get(kind, key, now());
    return row ? JSON.parse(row.value as string) as T : undefined;
  }

  put(kind: string, key: string, value: unknown, expiresAt: number): void {
    if (!Number.isSafeInteger(expiresAt)) throw new Error('Invalid state expiry');
    this.cleanup();
    this.db.prepare('INSERT INTO auth_state (kind, key, value, expires_at) VALUES (?, ?, ?, ?) ON CONFLICT(kind, key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at').run(kind, key, JSON.stringify(value), expiresAt);
  }

  delete(kind: string, key: string): void {
    this.db.prepare('DELETE FROM auth_state WHERE kind = ? AND key = ?').run(kind, key);
  }

  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      if (result instanceof Promise) throw new Error('Auth transactions must be synchronous');
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  close(): void { this.db.close(); }
}
