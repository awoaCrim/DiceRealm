-- 015_campaign_state_revision.sql
-- Independent monotonic campaign runtime revision head and append-only ledger.
-- Revision 0 is the migration baseline for existing campaigns; it is not a
-- fabricated historical mutation and therefore has no ledger row.

CREATE TABLE IF NOT EXISTS platform_campaign_state_heads (
  campaign_id TEXT PRIMARY KEY REFERENCES campaigns(id),
  revision INTEGER NOT NULL CHECK (revision >= 0),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS platform_campaign_state_revisions (
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  revision INTEGER NOT NULL CHECK (revision > 0),
  mutation_id TEXT NOT NULL,
  cause_type TEXT NOT NULL,
  cause_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (campaign_id, revision),
  UNIQUE (campaign_id, mutation_id)
);

ALTER TABLE platform_ai_runs ADD COLUMN expected_state_revision INTEGER;
ALTER TABLE platform_ai_runs ADD COLUMN applied_state_revision INTEGER;

INSERT INTO platform_campaign_state_heads (campaign_id, revision, updated_at)
SELECT c.id, 0, CURRENT_TIMESTAMP
FROM campaigns c
WHERE NOT EXISTS (
  SELECT 1 FROM platform_campaign_state_heads h WHERE h.campaign_id = c.id
);

CREATE INDEX IF NOT EXISTS platform_campaign_state_revisions_campaign_idx
  ON platform_campaign_state_revisions(campaign_id, revision);
