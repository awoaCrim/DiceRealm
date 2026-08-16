-- 013_secure_sessions.sql
-- Phase 2: digest-only sessions and account auth state.
--
-- Forward-only additive migration: does NOT delete old rows, rewrite historic
-- tokens, or rebuild 001. Legacy rows keep NULL secure columns so the offline
-- security cutover can identify and remove them wholesale. The application has
-- NO dual-read path: new code only creates rows where every secure field is
-- non-null, and authority is always the secure columns.
--
-- `ALTER TABLE ... ADD COLUMN` is used instead of table rebuild so existing
-- Existing baseline databases keep their rows untouched.

ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled'));
ALTER TABLE users ADD COLUMN auth_revision INTEGER NOT NULL DEFAULT 0 CHECK (auth_revision >= 0);

ALTER TABLE sessions ADD COLUMN token_digest TEXT NULL;
ALTER TABLE sessions ADD COLUMN csrf_digest TEXT NULL;
ALTER TABLE sessions ADD COLUMN captured_auth_revision INTEGER NULL;
ALTER TABLE sessions ADD COLUMN revoke_epoch INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN revoked_at TEXT NULL;
ALTER TABLE sessions ADD COLUMN absolute_expires_at TEXT NULL;
ALTER TABLE sessions ADD COLUMN idle_expires_at TEXT NULL;
ALTER TABLE sessions ADD COLUMN last_seen_at TEXT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_token_digest ON sessions(token_digest) WHERE token_digest IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sessions_user_revoked ON sessions(user_id, revoked_at);
CREATE INDEX IF NOT EXISTS idx_sessions_absolute_expires ON sessions(absolute_expires_at);
CREATE INDEX IF NOT EXISTS idx_sessions_idle_expires ON sessions(idle_expires_at);
