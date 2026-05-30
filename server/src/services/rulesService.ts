import { nanoid } from 'nanoid';
import type { AppDatabase } from '../db/connection.js';

export function listRuleSources(db: AppDatabase): unknown[] {
  return db.prepare('SELECT id, name, source_type as sourceType, content_json as contentJson, created_at as createdAt FROM rule_sources ORDER BY created_at ASC').all();
}

export function importRuleSource(db: AppDatabase, name: string, content: unknown): string {
  const id = nanoid();
  db.prepare(`
    INSERT INTO rule_sources (id, name, source_type, content_json, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, name, 'imported', JSON.stringify(content), new Date().toISOString());
  return id;
}
