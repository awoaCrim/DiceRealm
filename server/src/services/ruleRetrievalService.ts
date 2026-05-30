import { createHash } from 'node:crypto';
import { nanoid } from 'nanoid';
import type { AppDatabase } from '../db/connection.js';
import type { RuleRetrievalMatch, RuleSummary } from '../domain/types.js';
import type { EmbeddingProvider } from './embeddingService.js';

interface ApprovedRuleRow {
  id: string;
  title: string;
  category: string;
  summary: string;
  content: string;
  keysJson: string;
  sourceRef: string;
  priority: number;
}

interface RuleEmbeddingRow {
  entryId: string;
  embeddingJson: string;
}

export interface RuleIndexResult {
  indexed: number;
  skipped: number;
}

function approvedRuleRows(db: AppDatabase): ApprovedRuleRow[] {
  return db.prepare(`
    SELECT id, title, category, summary, content, keys_json as keysJson,
      source_ref as sourceRef, priority
    FROM rule_world_book_entries
    WHERE enabled = 1
    ORDER BY priority DESC, title ASC
  `).all() as ApprovedRuleRow[];
}

function parseKeys(keysJson: string): string[] {
  try {
    const value = JSON.parse(keysJson) as unknown;
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function contentForEmbedding(row: ApprovedRuleRow): string {
  return [
    `title: ${row.title}`,
    `category: ${row.category}`,
    `summary: ${row.summary}`,
    `content: ${row.content}`,
    `keys: ${parseKeys(row.keysJson).join(', ')}`
  ].join('\n');
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length === 0 || left.length !== right.length) return 0;

  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
  }

  if (leftNorm === 0 || rightNorm === 0) return 0;
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

function parseEmbeddingVector(embeddingJson: string): number[] {
  try {
    const value = JSON.parse(embeddingJson) as unknown;
    return Array.isArray(value) ? value.filter((item): item is number => typeof item === 'number' && Number.isFinite(item)) : [];
  } catch {
    return [];
  }
}

export async function indexApprovedRuleEntries(db: AppDatabase, provider: EmbeddingProvider): Promise<RuleIndexResult> {
  let indexed = 0;
  let skipped = 0;
  const now = new Date().toISOString();
  const existing = db.prepare('SELECT content_hash as contentHash FROM rule_entry_embeddings WHERE entry_id = ?');
  const upsert = db.prepare(`
    INSERT INTO rule_entry_embeddings (entry_id, embedding_json, content_hash, indexed_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(entry_id) DO UPDATE SET
      embedding_json = excluded.embedding_json,
      content_hash = excluded.content_hash,
      indexed_at = excluded.indexed_at
  `);

  for (const row of approvedRuleRows(db)) {
    const text = contentForEmbedding(row);
    const hash = `${sha256(text)}:${provider.fingerprint}`;
    const current = existing.get(row.id) as { contentHash: string } | undefined;
    if (current?.contentHash === hash) {
      skipped += 1;
      continue;
    }

    const embedding = await provider.embed(text);
    upsert.run(row.id, JSON.stringify(embedding), hash, now);
    indexed += 1;
  }

  return { indexed, skipped };
}

export async function retrieveRuleMatches(
  db: AppDatabase,
  provider: EmbeddingProvider,
  query: string,
  options: { limit?: number } = {}
): Promise<RuleRetrievalMatch[]> {
  const limit = options.limit ?? 5;
  let queryEmbedding: number[] | null = null;
  try {
    queryEmbedding = await provider.embed(query);
  } catch {
    queryEmbedding = null;
  }

  const normalizedQuery = query.toLocaleLowerCase();
  const embeddingRows = db.prepare(`
    SELECT entry_id as entryId, embedding_json as embeddingJson
    FROM rule_entry_embeddings
  `).all() as RuleEmbeddingRow[];
  const embeddingsByEntryId = new Map(embeddingRows.map((row) => [row.entryId, row.embeddingJson]));

  return approvedRuleRows(db).map((row): RuleRetrievalMatch | null => {
    const keys = parseKeys(row.keysJson);
    const hasKeyword = keys.some((key) => normalizedQuery.includes(key.toLocaleLowerCase()));
    const embeddingJson = embeddingsByEntryId.get(row.id);
    const semantic = queryEmbedding && embeddingJson
      ? cosineSimilarity(queryEmbedding, parseEmbeddingVector(embeddingJson))
      : 0;
    const reasons: Array<'keyword' | 'semantic'> = [];
    if (hasKeyword) reasons.push('keyword');
    if (semantic > 0) reasons.push('semantic');

    const keywordScore = hasKeyword ? 1 : 0;
    const score = keywordScore + Math.max(semantic, 0) + row.priority / 10000;
    if (score <= 0 || reasons.length === 0) return null;

    return {
      entryId: row.id,
      title: row.title,
      category: row.category,
      summary: row.summary,
      content: row.content,
      keys,
      sourceRef: row.sourceRef,
      score,
      reasons
    };
  }).filter((match): match is RuleRetrievalMatch => match !== null)
    .sort((left, right) => right.score - left.score || left.title.localeCompare(right.title))
    .slice(0, limit);
}

export function storeRuleContextHits(
  db: AppDatabase,
  input: { roomId: string; turnId: string | null; matches: RuleRetrievalMatch[] }
): void {
  const now = new Date().toISOString();
  const insert = db.prepare(`
    INSERT INTO rule_context_hits (id, room_id, turn_id, entry_id, title, summary, reason, score, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  db.transaction(() => {
    for (const match of input.matches) {
      insert.run(
        nanoid(),
        input.roomId,
        input.turnId,
        match.entryId,
        match.title,
        match.summary,
        `参考规则：${match.title}`,
        match.score,
        now
      );
    }
  })();
}

export function listRuleSummariesForRoom(db: AppDatabase, roomId: string, limit = 5): RuleSummary[] {
  return db.prepare(`
    SELECT entry_id as entryId, title, summary, reason, created_at as createdAt
    FROM rule_context_hits
    WHERE room_id = ?
    ORDER BY created_at DESC, score DESC
    LIMIT ?
  `).all(roomId, limit) as RuleSummary[];
}
