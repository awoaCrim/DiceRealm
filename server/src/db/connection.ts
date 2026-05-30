import Database from 'better-sqlite3';
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
