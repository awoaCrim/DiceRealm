-- 010_ai_provider_credentials.sql
-- Campaign-scoped AI Provider configuration. API keys are stored only as
-- authenticated ciphertext (AES-GCM envelope produced by the server); plaintext
-- credentials never enter this table. Portable across SQLite and PostgreSQL.

CREATE TABLE IF NOT EXISTS platform_ai_provider_configs (
  campaign_id TEXT PRIMARY KEY REFERENCES campaigns(id),
  provider TEXT NOT NULL CHECK (provider IN ('openai-compatible')),
  base_url TEXT NOT NULL,
  model TEXT NOT NULL,
  encrypted_api_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
