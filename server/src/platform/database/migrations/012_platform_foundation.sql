-- 012_platform_foundation.sql
-- Phase 2: platform instance singleton, unique platform administrator, registration invites.
--
-- Schema only: this migration inserts NO rows. The CLI writes the singleton row
-- (database ID, credential key fingerprint, enrollment provenance) during
-- explicit init/enroll. Must stay compatible with SQLite and PostgreSQL basic
-- syntax (no SQLite-only functions or syntax in this file).

CREATE TABLE IF NOT EXISTS platform_instance (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  database_id TEXT NOT NULL UNIQUE,
  enrollment_state TEXT NOT NULL CHECK (enrollment_state IN ('initializing', 'ready')),
  credential_key_fingerprint TEXT NOT NULL,
  enrollment_key_origin TEXT NOT NULL CHECK (enrollment_key_origin IN ('generated', 'preexisting')),
  bootstrap_completed_at TEXT NULL,
  maintenance_state TEXT NOT NULL DEFAULT 'active' CHECK (maintenance_state IN ('active', 'draining', 'quiescent')),
  maintenance_epoch INTEGER NOT NULL DEFAULT 0 CHECK (maintenance_epoch >= 0),
  platform_rules_revision INTEGER NOT NULL DEFAULT 0 CHECK (platform_rules_revision >= 0),
  session_security_state TEXT NOT NULL DEFAULT 'pending' CHECK (session_security_state IN ('pending', 'cleaning', 'ready')),
  session_security_cutover_at TEXT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS platform_administrators (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  user_id TEXT NOT NULL UNIQUE REFERENCES users(id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS platform_registration_invites (
  id TEXT PRIMARY KEY,
  token_digest TEXT NOT NULL UNIQUE,
  created_by_user_id TEXT NOT NULL REFERENCES users(id),
  expires_at TEXT NOT NULL,
  revoked_at TEXT NULL,
  consumed_at TEXT NULL,
  consumed_by_user_id TEXT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_invites_expires_at ON platform_registration_invites(expires_at);
CREATE INDEX IF NOT EXISTS idx_invites_created_at_desc ON platform_registration_invites(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_invites_consumed_revoked ON platform_registration_invites(consumed_at, revoked_at);
