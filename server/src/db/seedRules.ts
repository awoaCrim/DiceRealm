import { nanoid } from 'nanoid';
import type { AppDatabase } from './connection.js';

const builtinRules = {
  name: 'Built-in SRD-style starter rules',
  abilityChecks: 'Roll d20 + ability modifier + proficiency when applicable.',
  savingThrows: 'Roll d20 + ability modifier + proficiency when proficient.',
  combat: 'Use initiative order, armor class, attack rolls, damage rolls, and hit points.',
  note: 'This starter set is intentionally brief and only uses open, user-editable data.'
};

export function seedBuiltinRules(db: AppDatabase): void {
  const existing = db.prepare('SELECT id FROM rule_sources WHERE source_type = ? LIMIT 1').get('builtin');
  if (existing) return;

  db.prepare(`
    INSERT INTO rule_sources (id, name, source_type, content_json, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(nanoid(), builtinRules.name, 'builtin', JSON.stringify(builtinRules), new Date().toISOString());
}
