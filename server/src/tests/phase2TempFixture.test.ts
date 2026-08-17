import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  APPROVED_MIGRATION_FILENAMES,
  assertSafePhase2Path,
  createPhase2TempFixture,
  REPO_DEFAULT_PATHS,
} from './phase2TempFixture.js';

describe('phase2TempFixture path safety', () => {
  it('rejects every repo default DB/key absolute path', () => {
    for (const p of REPO_DEFAULT_PATHS) {
      expect(() => assertSafePhase2Path(p), p).toThrow(/拒绝仓库默认路径/);
    }
  });

  it('rejects the same paths when given as relative or alternate forms', () => {
    for (const p of ['dnd.sqlite', 'server/dnd.sqlite', '.dnd-ai-credential-key', 'server/.dnd-ai-credential-key']) {
      expect(() => assertSafePhase2Path(p), p).toThrow(/拒绝仓库默认路径/);
    }
  });

  it('accepts mkdtemp absolute paths', () => {
    const fixture = createPhase2TempFixture();
    try {
      expect(() => assertSafePhase2Path(fixture.databasePath)).not.toThrow();
      expect(() => assertSafePhase2Path(fixture.keyPath)).not.toThrow();
      expect(() => assertSafePhase2Path(fixture.backupDir)).not.toThrow();
    } finally {
      fixture.cleanup();
    }
  });
});

describe('phase2TempFixture lifecycle', () => {
  it('creates absolute paths on one temp dir and cleans up completely', () => {
    const fixture = createPhase2TempFixture();
    expect(resolve(fixture.databasePath)).toBe(fixture.databasePath);
    expect(resolve(fixture.keyPath)).toBe(fixture.keyPath);
    expect(resolve(fixture.backupDir)).toBe(fixture.backupDir);
    expect(existsSync(fixture.backupDir)).toBe(true);
    // backup 与 database 同 parent filesystem（同 dir）。
    expect(join(fixture.dir, 'backup')).toBe(fixture.backupDir);
    const dir = fixture.dir;
    fixture.cleanup();
    expect(existsSync(dir)).toBe(false);
  });

  it('cleanup is idempotent', () => {
    const fixture = createPhase2TempFixture();
    fixture.cleanup();
    fixture.cleanup();
  });
});

describe('approved migration set', () => {
  it('freezes the current Phase migration set', () => {
    expect(APPROVED_MIGRATION_FILENAMES).toEqual([
      '001_initial_platform.sql',
      '002_campaign_invites.sql',
      '003_characters.sql',
      '004_world_state.sql',
      '005_events_outbox.sql',
      '006_turns_actions.sql',
      '007_archives.sql',
      '008_ai_runtime.sql',
      '009_combat.sql',
      '010_ai_provider_credentials.sql',
      '012_platform_foundation.sql',
      '013_secure_sessions.sql',
      '014_security_audit.sql',
      '015_campaign_state_revision.sql',
      '016_server_adjudication_dice.sql',
      '017_narrative_runtime_fact_memory.sql',
      '018_narrative_work_consumer_receipts.sql',
    ]);
  });
});
