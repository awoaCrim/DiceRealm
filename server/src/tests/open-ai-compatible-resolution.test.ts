import http from 'node:http';
import { describe, expect, it } from 'vitest';
import type { CampaignAuthContext } from '../modules/campaigns/CampaignAccess.js';
import { resolveCampaignContext } from '../modules/campaigns/CampaignAccess.js';
import { CampaignService } from '../modules/campaigns/CampaignService.js';
import { CharacterService } from '../modules/characters/CharacterService.js';
import { IdentityService } from '../modules/identity/IdentityService.js';
import { createSqliteDatabase } from '../platform/database/SqliteDatabaseAdapter.js';
import { OutboxRepository } from '../platform/events/OutboxRepository.js';
import { TurnService } from '../modules/turns/TurnService.js';
import { ArchiveService } from '../modules/archives/ArchiveService.js';
import { AiContextBuilder } from '../modules/ai-runtime/AiContextBuilder.js';
import { TurnResolutionValidator } from '../modules/ai-runtime/TurnResolutionValidator.js';
import { StateChangeMaterializer } from '../modules/ai-runtime/StateChangeMaterializer.js';
import { AiResolutionService } from '../modules/ai-runtime/AiResolutionService.js';
import { OpenAiCompatibleAiProvider } from '../modules/ai-runtime/OpenAiCompatibleAiProvider.js';

async function createChatStub(handler: (body: unknown, count: number) => { status?: number; body?: unknown; rawBody?: string }) {
  let count = 0;
  const server = http.createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      count += 1;
      const result = handler(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'), count);
      res.statusCode = result.status ?? 200;
      res.setHeader('content-type', 'application/json');
      res.end(result.rawBody ?? JSON.stringify(result.body));
    })().catch((error) => {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No stub port');
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    count: () => count,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** 完整平台 AI runtime fixture：真实内存 SQLite + 真实 OpenAI-compatible 适配器（本地 HTTP stub）。 */
async function makeFixture(baseUrl: string) {
  const db = createSqliteDatabase(':memory:');
  await db.migrate();
  const identity = new IdentityService(db);
  const campaigns = new CampaignService(db);
  const characters = new CharacterService(db);
  const owner = await identity.register({ login: 'owner@example.test', password: 'correct-password' });
  const a = await identity.register({ login: 'a@example.test', password: 'correct-password' });
  const b = await identity.register({ login: 'b@example.test', password: 'correct-password' });
  const created = await campaigns.create(owner.userId, { name: '失落矿坑', ruleset: 'dnd5e' });
  for (const user of [a, b]) await campaigns.join({ userId: user.userId }, created.campaign.id, created.inviteCode);
  const ownerCtx = await resolveCampaignContext(db, { userId: owner.userId }, created.campaign.id);
  const aCtx = await resolveCampaignContext(db, { userId: a.userId }, created.campaign.id);
  const bCtx = await resolveCampaignContext(db, { userId: b.userId }, created.campaign.id);
  const approve = async (ctx: CampaignAuthContext, name: string) => {
    const draft = await characters.createDraft(ctx, { name, sheet: { ac: 14 } });
    await characters.submitForReview(ctx, draft.id);
    await characters.approve(ownerCtx, draft.id);
  };
  await approve(aCtx, '薇拉');
  await approve(bCtx, '卡恩');
  const outbox = new OutboxRepository(db);
  const turns = new TurnService(db, outbox);
  const turn = await turns.startTurn(ownerCtx);
  await turns.submitAction(aCtx, turn.id, { body: '我搜索房间。' });
  await turns.submitAction(bCtx, turn.id, { body: '我警戒门口。' });
  const archives = new ArchiveService(db, outbox);
  const provider = new OpenAiCompatibleAiProvider(
    { baseUrl, apiKey: 'secret-key', model: 'gpt-test-model' },
    { timeoutMs: 5000, temperature: 0.7 },
  );
  const service = new AiResolutionService(
    db, provider, outbox, archives,
    new AiContextBuilder(db), new TurnResolutionValidator(db), new StateChangeMaterializer(db),
  );
  return { db, service, ownerCtx, turn };
}

const successContent = '{"publicNarrative":"雨停了，队伍继续前进。","privateUpdates":[],"diceResults":[],"stateChanges":[],"interactionRequests":[]}';

describe('openai-compatible resolution vertical', () => {
  it('resolves a locked turn through the real adapter with a full formal apply', async () => {
    const stub = await createChatStub(() => ({
      body: { choices: [{ message: { content: successContent } }] },
    }));
    try {
      const { db, service, ownerCtx, turn } = await makeFixture(stub.baseUrl);
      try {
        const result = await service.resolveTurn(ownerCtx, turn.id, { idempotencyKey: 'real-provider-1' });
        expect(result.created).toBe(true);
        expect(result.run.status).toBe('succeeded');
        expect(result.run.provider).toBe('openai-compatible');
        expect(result.run.model).toBe('gpt-test-model');
        const runRow = await db.query<{ provider: string; model: string }>(
          'SELECT provider, model FROM platform_ai_runs WHERE turn_id = ?', [turn.id],
        );
        expect(runRow[0]).toEqual({ provider: 'openai-compatible', model: 'gpt-test-model' });
        const turnRow = await db.query<{ status: string }>('SELECT status FROM platform_turns WHERE id = ?', [turn.id]);
        expect(turnRow[0].status).toBe('completed');
        const entries = await db.query<{ entry_kind: string; payload_json: string }>(
          'SELECT entry_kind, payload_json FROM platform_turn_entries WHERE turn_id = ? ORDER BY entry_index', [turn.id],
        );
        expect(entries[0]).toEqual({ entry_kind: 'narrative', payload_json: JSON.stringify({ text: '雨停了，队伍继续前进。' }) });
        const archives = await db.query('SELECT id FROM platform_archives WHERE campaign_id = ?', [turn.campaignId]);
        expect(archives).toHaveLength(1);
        const next = await db.query<{ number: number; status: string }>(
          'SELECT number, status FROM platform_turns WHERE campaign_id = ? AND number = 2', [turn.campaignId],
        );
        expect(next).toEqual([{ number: 2, status: 'waiting_for_actions' }]);
        const events = await db.query<{ event_type: string; payload_json: string }>(
          'SELECT event_type, payload_json FROM platform_outbox_events WHERE campaign_id = ? ORDER BY sequence', [turn.campaignId],
        );
        const delta = events.find((e) => e.event_type === 'ai.preview.delta');
        expect(delta).toBeTruthy();
        // 预览 delta 只含公开叙事，绝不广播原始 JSON（含 private/owner-only 字段）或任何密钥。
        expect(delta!.payload_json).toContain('雨停了');
        expect(delta!.payload_json).not.toContain('secret-key');
        expect(delta!.payload_json).not.toContain('"privateUpdates"');
        // API key 绝不进入任何落库列（run 的 context/result/error/raw_debug + outbox payload）。
        const runRows = await db.query<{ context_json: string; result_json: string | null; error_json: string | null; raw_debug_json: string | null }>(
          'SELECT context_json, result_json, error_json, raw_debug_json FROM platform_ai_runs WHERE turn_id = ?', [turn.id],
        );
        expect(JSON.stringify(runRows)).not.toContain('secret-key');
        expect(JSON.stringify(events)).not.toContain('secret-key');
        expect(stub.count()).toBe(1);
      } finally {
        await db.close();
      }
    } finally {
      await stub.close();
    }
  });

  it('normalizes omitted empty collections from a minimal Provider object', async () => {
    let requestBody: unknown;
    const stub = await createChatStub((body) => {
      requestBody = body;
      return { body: { choices: [{ message: { content: '{"publicNarrative":"雨停了，队伍继续前进。"}' } }] } };
    });
    try {
      const { db, service, ownerCtx, turn } = await makeFixture(stub.baseUrl);
      try {
        const result = await service.resolveTurn(ownerCtx, turn.id, { idempotencyKey: 'minimal-provider-object' });
        expect(result.run.status).toBe('succeeded');
        const rows = await db.query<{ result_json: string | null }>(
          'SELECT result_json FROM platform_ai_runs WHERE id = ?', [result.run.id],
        );
        const resolution = JSON.parse(rows[0].result_json as string) as Record<string, unknown>;
        expect(resolution).toMatchObject({
          privateUpdates: [],
          diceResults: [],
          stateChanges: [],
          interactionRequests: [],
          worldFactCreations: [],
          encounterStarts: [],
        });
        const outbound = requestBody as {
          messages: Array<{ content: string }>;
          response_format?: unknown;
          tools?: unknown;
        };
        const outboundText = outbound.messages.map((message) => message.content).join('\n');
        expect(outboundText).toContain('只返回一个 JSON 对象');
        expect(outboundText).toContain('"encounterStarts"');
        expect(outbound).not.toHaveProperty('response_format');
        expect(outbound).not.toHaveProperty('tools');
        expect(stub.count()).toBe(1);
      } finally {
        await db.close();
      }
    } finally {
      await stub.close();
    }
  });

  it('classifies upstream failures as AI_PROVIDER_FAILED without leaking the api key', async () => {
    const stub = await createChatStub(() => ({ status: 500, body: { error: { message: 'boom secret-key' } } }));
    try {
      const { db, service, ownerCtx, turn } = await makeFixture(stub.baseUrl);
      try {
        await expect(service.resolveTurn(ownerCtx, turn.id, { idempotencyKey: 'real-provider-fail' }))
          .rejects.toMatchObject({ code: 'AI_PROVIDER_FAILED' });
        const run = await db.query<{ status: string; error_code: string | null; error_json: string | null; raw_debug_json: string | null; context_json: string }>(
          'SELECT status, error_code, error_json, raw_debug_json, context_json FROM platform_ai_runs WHERE turn_id = ?', [turn.id],
        );
        expect(run[0].status).toBe('failed');
        expect(run[0].error_code).toBe('AI_PROVIDER_FAILED');
        expect(JSON.stringify(run)).not.toContain('secret-key');
        const turnRow = await db.query<{ status: string }>('SELECT status FROM platform_turns WHERE id = ?', [turn.id]);
        expect(turnRow[0].status).toBe('needs_owner_attention');
        expect((await db.query('SELECT id FROM platform_turn_entries WHERE turn_id = ?', [turn.id])).length).toBe(0);
        expect((await db.query('SELECT id FROM platform_archives WHERE campaign_id = ?', [turn.campaignId])).length).toBe(0);
      } finally {
        await db.close();
      }
    } finally {
      await stub.close();
    }
  });
});
