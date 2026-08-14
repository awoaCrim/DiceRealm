import { describe, expect, it } from 'vitest';
import { createSqliteDatabase } from '../../platform/database/SqliteDatabaseAdapter.js';
import type { AiPrompt } from '@dnd/contracts';
import { AiProviderConfigService } from './AiProviderConfigService.js';
import { CredentialCipher } from './CredentialCipher.js';
import { ScriptedAiProvider } from './ScriptedAiProvider.js';

const prompt: AiPrompt = {
  campaignId: 'c-config',
  audience: 'owner_only',
  messages: [{ role: 'system', content: 'system' }, { role: 'user', content: 'go' }],
  characters: [],
};

describe('AiProviderConfigService dynamic provider resolution', () => {
  it('switches subsequent resolutions immediately after save and never passes ciphertext to the provider factory', async () => {
    const db = createSqliteDatabase(':memory:');
    await db.migrate();
    try {
      const now = new Date().toISOString();
      await db.execute('INSERT INTO users (id, login, password_hash) VALUES (?, ?, ?)', ['owner-config', 'owner-config', 'hash']);
      await db.execute('INSERT INTO campaigns (id, owner_id, name, ruleset, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', ['c-config', 'owner-config', '配置战役', 'dnd5e', 'active', now, now]);
      await db.execute('INSERT INTO campaign_members (campaign_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)', ['c-config', 'owner-config', 'owner', now]);

      const captured: Array<{ apiKey: string; baseUrl: string; model: string }> = [];
      const savedProvider = new ScriptedAiProvider(async () => ({ source: 'saved' }));
      const fallback = new ScriptedAiProvider(async () => ({ source: 'fallback' }));
      const service = new AiProviderConfigService(db, {
        fallbackProvider: fallback,
        credentialCipher: CredentialCipher.generate(),
        providerFactory: (config) => {
          captured.push({ apiKey: config.apiKey, baseUrl: config.baseUrl, model: config.model });
          return savedProvider;
        },
      });
      const ctx = { campaignId: 'c-config', userId: 'owner-config', playerId: null, role: 'owner' as const };

      const before = await service.resolve('c-config');
      expect(await before.stream(prompt, { onDelta: async () => {} })).toEqual({ source: 'fallback' });

      await service.save(ctx, {
        provider: 'openai-compatible', baseUrl: 'https://saved.example/v1', model: 'saved-model', apiKey: 'sk-runtime-secret',
      });
      const after = await service.resolve('c-config');
      expect(await after.stream(prompt, { onDelta: async () => {} })).toEqual({ source: 'saved' });
      expect(captured).toEqual([{ apiKey: 'sk-runtime-secret', baseUrl: 'https://saved.example/v1', model: 'saved-model' }]);

      const row = await db.query<{ encrypted_api_key: string }>('SELECT encrypted_api_key FROM platform_ai_provider_configs WHERE campaign_id = ?', ['c-config']);
      expect(row[0].encrypted_api_key).not.toContain('sk-runtime-secret');
    } finally {
      await db.close();
    }
  });

  it('test() keeps fixed 15s timeout and temperature 0 and issues exactly one request', async () => {
    const db = createSqliteDatabase(':memory:');
    await db.migrate();
    try {
      const now = new Date().toISOString();
      await db.execute('INSERT INTO users (id, login, password_hash) VALUES (?, ?, ?)', ['owner-config-2', 'owner-config-2', 'hash']);
      await db.execute('INSERT INTO campaigns (id, owner_id, name, ruleset, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', ['c-config-2', 'owner-config-2', '配置战役2', 'dnd5e', 'active', now, now]);
      await db.execute('INSERT INTO campaign_members (campaign_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)', ['c-config-2', 'owner-config-2', 'owner', now]);

      let calls = 0;
      let lastBody: unknown = null;
      const service = new AiProviderConfigService(db, {
        fallbackProvider: new ScriptedAiProvider(async () => ({ source: 'fallback' })),
        credentialCipher: CredentialCipher.generate(),
        fetchImpl: async (_input, init) => {
          calls += 1;
          lastBody = JSON.parse(String(init?.body ?? '{}')) as unknown;
          return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 });
        },
      });
      const ctx = { campaignId: 'c-config-2', userId: 'owner-config-2', playerId: null, role: 'owner' as const };
      await service.save(ctx, {
        provider: 'openai-compatible', baseUrl: 'https://saved.example/v1', model: 'saved-model', apiKey: 'sk-test-key',
      });
      await service.test(ctx, {
        provider: 'openai-compatible', baseUrl: 'https://saved.example/v1', model: 'saved-model', apiKey: '',
      });
      expect(calls).toBe(1);
      const body = lastBody as { temperature: number };
      expect(body.temperature).toBe(0);
    } finally {
      await db.close();
    }
  });
});
