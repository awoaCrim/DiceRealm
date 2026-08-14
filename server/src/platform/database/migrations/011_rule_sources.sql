-- 011_rule_sources.sql
-- Immutable metadata-only registry for rule provenance. Rule bodies/content are
-- deliberately not stored here. Portable across SQLite and PostgreSQL.

CREATE TABLE IF NOT EXISTS platform_rule_sources (
  id TEXT PRIMARY KEY,
  source_name TEXT NOT NULL CHECK (length(trim(source_name)) > 0),
  version TEXT NOT NULL CHECK (length(trim(version)) > 0),
  license TEXT NOT NULL CHECK (length(trim(license)) > 0),
  attribution TEXT NOT NULL CHECK (length(trim(attribution)) > 0),
  content_hash TEXT NOT NULL CHECK (
    length(content_hash) = 64
    AND content_hash = lower(content_hash)
    AND length(
      replace(replace(replace(replace(replace(replace(replace(replace(
      replace(replace(replace(replace(replace(replace(replace(replace(
        content_hash,
        '0', ''), '1', ''), '2', ''), '3', ''), '4', ''), '5', ''), '6', ''), '7', ''),
        '8', ''), '9', ''), 'a', ''), 'b', ''), 'c', ''), 'd', ''), 'e', ''), 'f', '')
    ) = 0
  ),
  scope TEXT NOT NULL CHECK (scope IN ('platform', 'campaign', 'user')),
  campaign_id TEXT REFERENCES campaigns(id),
  user_id TEXT REFERENCES users(id),
  created_by_user_id TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (
    (scope = 'platform' AND campaign_id IS NULL AND user_id IS NULL AND created_by_user_id IS NULL)
    OR (scope = 'campaign' AND campaign_id IS NOT NULL AND user_id IS NULL AND created_by_user_id IS NOT NULL)
    OR (scope = 'user' AND campaign_id IS NULL AND user_id IS NOT NULL AND created_by_user_id IS NOT NULL)
  )
);

-- PostgreSQL treats NULLs as distinct in UNIQUE constraints, so one generic
-- target tuple would not deduplicate platform/campaign/user identities. Use one
-- partial unique index per scope instead; SQLite and PostgreSQL both support it.
CREATE UNIQUE INDEX IF NOT EXISTS platform_rule_sources_platform_identity_idx
  ON platform_rule_sources(source_name, version)
  WHERE scope = 'platform';

CREATE UNIQUE INDEX IF NOT EXISTS platform_rule_sources_campaign_identity_idx
  ON platform_rule_sources(campaign_id, source_name, version)
  WHERE scope = 'campaign';

CREATE UNIQUE INDEX IF NOT EXISTS platform_rule_sources_user_identity_idx
  ON platform_rule_sources(user_id, source_name, version)
  WHERE scope = 'user';

CREATE UNIQUE INDEX IF NOT EXISTS platform_rule_sources_platform_hash_idx
  ON platform_rule_sources(content_hash)
  WHERE scope = 'platform';

CREATE UNIQUE INDEX IF NOT EXISTS platform_rule_sources_campaign_hash_idx
  ON platform_rule_sources(campaign_id, content_hash)
  WHERE scope = 'campaign';

CREATE UNIQUE INDEX IF NOT EXISTS platform_rule_sources_user_hash_idx
  ON platform_rule_sources(user_id, content_hash)
  WHERE scope = 'user';

CREATE INDEX IF NOT EXISTS platform_rule_sources_campaign_scope_idx
  ON platform_rule_sources(scope, campaign_id, created_at);

CREATE INDEX IF NOT EXISTS platform_rule_sources_user_scope_idx
  ON platform_rule_sources(scope, user_id, created_at);
