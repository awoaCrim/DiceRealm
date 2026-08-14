-- 014_security_audit.sql
-- Phase 2: DB-enforced append-only security audit log.
--
-- SQLite-only production line: the BEFORE UPDATE / BEFORE DELETE triggers use
-- RAISE(ABORT, ...) so the table can never be modified or deleted through SQL.
-- The application layer exposes no update/delete repository method.
--
-- PostgreSQL experiment lane does NOT run this migration in Phase 2
-- (deferred parity, recorded in the plan §8.1); the SQLite production line
-- must not be weakened for that experiment.

CREATE TABLE IF NOT EXISTS platform_security_audit_events (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('success', 'failure', 'rejected')),
  actor_user_id TEXT NULL REFERENCES users(id),
  subject_user_id TEXT NULL REFERENCES users(id),
  metadata_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_created_desc ON platform_security_audit_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_type_created ON platform_security_audit_events(event_type, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_subject_created ON platform_security_audit_events(subject_user_id, created_at);

CREATE TRIGGER IF NOT EXISTS audit_events_no_update
BEFORE UPDATE ON platform_security_audit_events
BEGIN
  SELECT RAISE(ABORT, 'security audit events are append-only');
END;

CREATE TRIGGER IF NOT EXISTS audit_events_no_delete
BEFORE DELETE ON platform_security_audit_events
BEGIN
  SELECT RAISE(ABORT, 'security audit events are append-only');
END;
