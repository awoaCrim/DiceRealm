import Database from 'better-sqlite3';
import type { SqliteDatabaseAdapter } from '../platform/database/SqliteDatabaseAdapter.js';
import { createSqliteDatabase } from '../platform/database/SqliteDatabaseAdapter.js';
import { loadConfig } from '../config.js';

export type AppDatabase = Database.Database;

let singleton: AppDatabase | null = null;

export function getDb(): AppDatabase {
  if (!singleton) {
    singleton = new Database(loadConfig().databasePath);
    singleton.pragma('journal_mode = WAL');
    singleton.pragma('foreign_keys = ON');
  }
  return singleton;
}

export function createMemoryDb(): AppDatabase {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  return db;
}

let platformSingleton: SqliteDatabaseAdapter | null = null;

/**
 * Return the singleton SQLite database adapter backed by the same
 * `better-sqlite3` connection as `getDb()`.
 *
 * New platform modules should use `getPlatformDb()` (which owns migration
 * runs and the async port). Legacy startup code can keep using `getDb()`
 * and call `migrateLegacy()` from `db/schema.ts`.
 */
export function getPlatformDb(): SqliteDatabaseAdapter {
  if (!platformSingleton) {
    platformSingleton = createSqliteDatabase(undefined, { reuseRaw: getDb() });
  }
  return platformSingleton;
}
