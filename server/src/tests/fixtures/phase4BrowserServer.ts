import { createServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createTestPlatformApp } from '../../app.js';
import { parseSecurityConfig } from '../../config.js';
import { createSqliteDatabase } from '../../platform/database/SqliteDatabaseAdapter.js';
import { ScriptedAiProvider, approvedPlayerIds } from '../../modules/ai-runtime/ScriptedAiProvider.js';
import { CredentialCipher } from '../../modules/ai-runtime/CredentialCipher.js';

/**
 * Phase 4 浏览器实测专用 fixture server（仅测试使用）。
 *
 * 约束：
 * - 只位于 server/src/tests/fixtures，绝不进入生产组合（server/src/index.ts 不 import；
 *   server/tsconfig.build.json 排除 src/tests/**，不会进入生产构建）。
 * - 使用 in-memory SQLite（createSqliteDatabase(':memory:')），绝不读写默认 DATABASE_PATH 指向的仓库根 dnd.sqlite。
 * - 注入 deterministic ScriptedAiProvider：按 prompt.characters 的真实 playerId 构造合法
 *   TurnResolution（publicNarrative + per-player privateUpdates），并逐条发送 preview delta。
 * - 不自带 vitest 依赖（区别于 httpTestHarness 的 expect 断言），供 tsx runner 直接加载。
 */

export interface Phase4FixtureServer {
  baseUrl: string;
  port: number;
  /** 浏览器填写的 test-only Provider 配置；连接测试成功，保存后 facade 仍委托 deterministic scripted provider。 */
  providerConfig: { baseUrl: string; model: string; apiKey: string };
  /**
   * 真正关闭并断开指定 campaign/viewer 的服务端 SSE 订阅与响应（浏览器 EventSource 会
   * onerror → 客户端带 ?after=lastSeen 重连）。返回实际关闭数量；0 表示未找到匹配连接。
   */
  disconnectViewer(campaignId: string, viewer: { role: 'owner' | 'player'; playerId: string | null }): number;
  close(): Promise<void>;
}

/** preview delta 文案：连接中断/重放测试断言完整串恰好出现一次。 */
export const PREVIEW_DELTAS = ['前', '方', '危', '险', '！'];

export const PUBLIC_NARRATIVE = '你们穿过密道，来到了烛堡深处的殿堂。';

/** 第二次结算（AI 创建世界事实 + 发起遭遇）的公开叙事。 */
export const SECOND_NARRATIVE = '密道深处传来低沉的吼声，伏击一触即发。';

/** 第二次结算创建的世界事实（public / playerA-private / owner-only）。 */
export const SECOND_WORLD_FACTS = [
  { title: '烛堡密道', kind: 'location', content: '石墙后藏着一条通往地宫深处的密道。', visibility: 'public' as const },
  { title: '影印暗记', kind: 'lore', content: '墙上的影印暗记只有你认得出。', visibility: 'player_private' as const },
  { title: '地宫主人', kind: 'npc', content: '地宫深处的主宰正注视着这一切。', visibility: 'owner_only' as const },
];

/** 第二次结算发起的遭遇（public / playerA-private / owner-only 战斗员，rollInitiative=true）。 */
export const SECOND_ENCOUNTER = {
  name: '密道伏击',
  combatants: [
    { name: '哥布林斥候', characterId: null, initiativeBonus: 2, hpCurrent: 9, hpMax: 9, ac: 13, conditions: [], visibility: 'public' as const, targetPlayerId: null },
    { name: '影缚刺客', characterId: null, initiativeBonus: 4, hpCurrent: 16, hpMax: 16, ac: 14, conditions: [], visibility: 'player_private' as const, targetPlayerId: null },
    { name: '地宫支配者', characterId: null, initiativeBonus: 5, hpCurrent: 40, hpMax: 40, ac: 17, conditions: [], visibility: 'owner_only' as const, targetPlayerId: null },
  ],
};

export interface StartPhase4FixtureServerOptions {
  /** 每个 preview delta 的间隔毫秒；默认 400ms（5 段共 2s，足够覆盖重连窗口）。 */
  previewDeltaMs?: number;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function startPhase4FixtureServer(
  options: StartPhase4FixtureServerOptions = {},
): Promise<Phase4FixtureServer> {
  const previewDeltaMs = options.previewDeltaMs ?? 400;

  const platformDb = createSqliteDatabase(':memory:');
  await platformDb.migrate();

  const provider = new ScriptedAiProvider(async (prompt, hooks) => {
    const playerIds = approvedPlayerIds(prompt);
    // 按当前回合号确定性分流：第一次结算（回合 #1）保留既有 SSE 重连/公开/私密叙事行为；
    // 第二次结算（回合 #2，由 turn-2 玩家行动触发）返回 worldFactCreations + encounterStarts。
    const turnText = prompt.messages.map((m) => m.content).join('\n');
    const turnMatch = /当前回合 #(\d+)/.exec(turnText);
    const turnNumber = turnMatch ? Number(turnMatch[1]) : 1;
    for (const text of PREVIEW_DELTAS) {
      await hooks.onDelta({ kind: 'text', text });
      await delay(previewDeltaMs);
    }
    const privateUpdates = playerIds.map((playerId) => ({
      playerId,
      content: `私密信息：${playerId.slice(0, 8)}`,
    }));
    if (turnNumber >= 2) {
      const playerA = playerIds[0] ?? null;
      return {
        publicNarrative: SECOND_NARRATIVE,
        privateUpdates,
        diceResults: [],
        stateChanges: [],
        interactionRequests: [],
        worldFactCreations: SECOND_WORLD_FACTS.map((fact) => ({
          ...fact,
          knownBy: fact.visibility === 'player_private' && playerA ? [playerA] : [],
        })),
        encounterStarts: [{
          ...SECOND_ENCOUNTER,
          combatants: SECOND_ENCOUNTER.combatants.map((combatant) => ({
            ...combatant,
            targetPlayerId: combatant.visibility === 'player_private' ? playerA : null,
          })),
        }],
      };
    }
    return {
      publicNarrative: PUBLIC_NARRATIVE,
      privateUpdates,
      diceResults: [],
      stateChanges: [],
      interactionRequests: [],
    };
  });

  const providerConfig = {
    baseUrl: 'http://phase4-provider.test/v1',
    model: 'phase4-scripted-model',
    apiKey: 'phase4-write-only-key',
  };
  const tlsKey = readFileSync(fileURLToPath(new URL('./tls/localhost-key.pem', import.meta.url)));
  const tlsCert = readFileSync(fileURLToPath(new URL('./tls/localhost-cert.pem', import.meta.url)));
  const server = createServer({ key: tlsKey, cert: tlsCert });
  server.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  const baseUrl = `https://127.0.0.1:${port}`;
  const { app, realtimeRuntime } = createTestPlatformApp(
    {
      database: platformDb,
      securityConfig: parseSecurityConfig({ NODE_ENV: 'test', PUBLIC_ORIGIN: baseUrl }),
      aiProvider: provider,
      credentialCipher: CredentialCipher.generate(),
    },
    {
      // 浏览器场景使用仅存于内存的本地 Provider transport，绝不触网/读写默认数据库。
      providerFetch: async (_input, init) => {
        const body = JSON.parse(String(init?.body ?? '{}')) as { messages?: Array<{ content?: string }> };
        const isConnectionTest = body.messages?.some((message) => message.content === 'Reply with ok.');
        if (isConnectionTest) {
          return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({ choices: [{ message: { content: '{}' } }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
      configuredAiProviderFactory: () => provider,
      // 短轮询/心跳：浏览器 SSE 实时验收按 20ms 轮询。
      realtimePollIntervalMs: 20,
      realtimeHeartbeatIntervalMs: 500,
    },
  );

  server.addListener('request', app);

  return {
    baseUrl,
    port,
    providerConfig,
    disconnectViewer: (campaignId, viewer) => {
      return realtimeRuntime.closeViewer?.(campaignId, viewer) ?? 0;
    },
    close: async () => {
      try {
        realtimeRuntime.closeAll();
      } finally {
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        });
        await platformDb.close();
      }
    },
  };
}
