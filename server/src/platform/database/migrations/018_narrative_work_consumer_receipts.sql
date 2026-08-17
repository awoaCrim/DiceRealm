-- 018_narrative_work_consumer_receipts.sql
-- Durable per-consumer receipts for outbox wake-up consumers.
-- published_at remains owned by the SSE/outbox delivery surface.

CREATE TABLE IF NOT EXISTS platform_outbox_consumer_receipts (
  consumer_name TEXT NOT NULL,
  event_id TEXT NOT NULL REFERENCES platform_outbox_events(id),
  handled_at TEXT NOT NULL,
  PRIMARY KEY (consumer_name, event_id)
);
