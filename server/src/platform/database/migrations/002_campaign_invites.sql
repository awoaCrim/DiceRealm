-- 002_campaign_invites.sql
-- Store only a SHA-256 digest of each campaign's invite code so that:
--   - the raw invite code is never persisted (unlike previous derived codes);
--   - join can be verified with a timing-safe comparison of digests.
-- The column is nullable so pre-existing campaigns remain valid until an
-- invite is provisioned (a null hash means "no invite yet", join is rejected).
-- Portable across SQLite and PostgreSQL (plain ALTER TABLE ADD COLUMN).
ALTER TABLE campaigns ADD COLUMN invite_code_hash TEXT;
