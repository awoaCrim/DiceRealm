import { nanoid } from 'nanoid';
import type {
  Archive,
  ArchiveKind,
  ArchiveRestoreResult,
  ArchiveSnapshot,
  ArchiveSnapshotCharacter,
  ArchiveSnapshotRequirement,
  ArchiveSnapshotV2,
  TurnAction,
} from '@dnd/contracts';
import { archiveSnapshotSchema, manualArchiveInputSchema } from '@dnd/contracts';
import type { DatabasePort, QueryExecutor } from '../../platform/database/DatabasePort.js';
import type { EventPublisherPort } from '../../platform/events/EventPublisherPort.js';
import { AppError } from '../../platform/http/AppError.js';
import { requireOwner, type CampaignAuthContext } from '../campaigns/CampaignAccess.js';
import { CharacterRepository, type CharacterRow } from '../characters/CharacterRepository.js';
import { TurnRepository, type ActionRow, type RequirementRow, type TurnRow } from '../turns/TurnRepository.js';
import { WorldFactRepository, type WorldFactRow } from '../world/WorldFactRepository.js';
import { CombatRepository, type CombatantRow, type EncounterRow } from '../combat/CombatRepository.js';
import { ArchiveRepository, type ArchiveRow } from './ArchiveRepository.js';
import { AiRunRepository } from '../ai-runtime/AiRunRepository.js';

/** 恢复两阶段 position 重排安全 offset：远大于任何真实 position 数量。 */
const POSITION_RESTORE_OFFSET = 2_000_000;

/**
 * ArchiveService：owner 手动/自动存档捕获与恢复。
 * 事务正确性核心：capture/restore 的读 + 状态检查 + 条件更新 + outbox 事件全部在同一个
 * DatabasePort.transaction 内（repository 用 tx 重新构造，绝不嵌套调用 TurnService.transaction）。
 * per-campaign version 由 ArchiveRepository.nextVersion 原子分配（绝不 MAX+1）；
 * restore 先 supersede 旧历史再 publish archive.restored（事件 sequence > snapshot watermark，
 * 不被本次恢复 supersede）；completed 快照同 tx 创建新 waiting turn（MAX+1 含 superseded，不复用号码）。
 */
export class ArchiveService {
  private readonly repository: ArchiveRepository;

  constructor(
    private readonly executor: DatabasePort,
    private readonly outbox: EventPublisherPort,
  ) {
    this.repository = new ArchiveRepository(executor);
  }

  /** owner 手动存档：label 必填 trimmed；current turn resolving → STATE_CONFLICT；无 turn/setup、waiting、locked、needs_owner_attention、completed 均允许。 */
  async createManual(ctx: CampaignAuthContext, label: string): Promise<Archive> {
    requireOwner(ctx);
    // label 必须非空且 trim；路由已用 manualArchiveInputSchema.parse，但 service 也要自校验（单元测试直接调用）。
    const input = manualArchiveInputSchema.parse({ label });
    return this.executor.transaction(async (tx) => {
      const repo = new ArchiveRepository(tx);
      const turns = new TurnRepository(tx);
      // 当前回合 resolving → STATE_CONFLICT（AI 结算中不允许存档，防止把中间状态写进快照）。
      if (await turns.findResolvingTurn(ctx.campaignId)) {
        throw new AppError('STATE_CONFLICT', '存在结算中的回合，无法手动存档。');
      }
      const version = await repo.nextVersion(tx, ctx.campaignId);
      const snapshot = await this.captureSnapshot(tx, ctx.campaignId, { forResolvedTurn: false });
      const archiveId = nanoid(24);
      const row = this.buildRow(ctx.campaignId, 'manual', snapshot.currentTurn?.turn.id ?? null, input.label, version, snapshot, ctx.userId, archiveId);
      await repo.insert(tx, row);
      return mapArchive(row);
    });
  }

  /** 恢复：owner-only + campaign 行锁 + 单 tx；先 supersede 旧历史，再 publish archive.restored。 */
  async restore(ctx: CampaignAuthContext, archiveId: string): Promise<ArchiveRestoreResult> {
    requireOwner(ctx);
    return this.executor.transaction(async (tx) => {
      // 1) 在 SQLite 写事务中触碰 campaign 行，建立恢复操作的串行化点。
      await tx.execute('UPDATE campaigns SET updated_at = updated_at WHERE id = ?', [ctx.campaignId]);
      const repo = new ArchiveRepository(tx);
      const archive = await repo.findById(archiveId);
      if (!archive || archive.campaign_id !== ctx.campaignId) {
        throw new AppError('NOT_FOUND', '存档不存在。');
      }
      // 2) 不存在 unsuperseded resolving turn / running run → 防止 provider 晚到结果污染恢复状态。
      //    两道独立守卫：① resolving turn（claim 已把 turn 置 resolving）；② running run（防御性兜底，
      //    覆盖 turn 非 resolving 但 run 仍 running 的异常窗口，如人工把 turn 改回其它状态而 run 未终结）。
      const turns = new TurnRepository(tx);
      const aiRuns = new AiRunRepository(tx);
      if (await turns.findResolvingTurn(ctx.campaignId)) {
        throw new AppError('STATE_CONFLICT', '存在结算中的回合，无法恢复存档。');
      }
      if (await aiRuns.findRunningRun(ctx.campaignId)) {
        throw new AppError('STATE_CONFLICT', '存在运行中的 AI 结算，无法恢复存档。');
      }
      // 3) 解析快照：malformed JSON 与 schema 校验失败统一归一为 INTERNAL_ERROR（不泄漏 SyntaxError）。
      let raw: unknown;
      try {
        raw = JSON.parse(archive.state_json);
      } catch {
        throw new AppError('INTERNAL_ERROR', '存档快照无效。');
      }
      const parsed = archiveSnapshotSchema.safeParse(raw);
      if (!parsed.success) {
        throw new AppError('INTERNAL_ERROR', '存档快照无效。');
      }
      const snapshot = parsed.data;
      // 3b) 快照自身 currentTurn 为 resolving 的快照不可恢复：即使 live DB 无 resolving turn / running run
      //     （如外部构造或人工改库产生的异常快照），也绝不允许把回合恢复进 resolving 状态。
      if (snapshot.currentTurn?.turn.status === 'resolving') {
        throw new AppError('STATE_CONFLICT', '结算中的回合快照无法恢复。');
      }
      const now = new Date().toISOString();
      // 4) 先 supersede 旧历史（被恢复 archive 的 version 作为 archives 超水位）。
      await this.supersedeHistory(tx, ctx.campaignId, archive.id, archive.version, snapshot, now);
      // 5) 恢复快照状态。
      const restoredTurnId = await this.restoreSnapshotState(tx, ctx.campaignId, snapshot, ctx.userId, now);
      // 5b) 选中 archive 自身解除 superseded，成为当前 active checkpoint；version > target 仍 superseded。
      //     使恢复后的 DTO superseded=false 且 listForCampaign 可见（产品语义：选中的存档成为当前状态）。
      await repo.clearSuperseded(archive.id);
      // 6) 最后 publish archive.restored（public；其 sequence > watermark，不被本次 supersede）。
      await this.outbox.publishIn(tx, {
        type: 'archive.restored', campaignId: ctx.campaignId, archiveId: archive.id, version: archive.version,
      });
      // 返回 DTO 前重读：确保 archive.superseded=false（选中 checkpoint 已重新激活）。
      const restoredArchive = (await repo.findById(archive.id)) as ArchiveRow;
      return { archive: mapArchive(restoredArchive), restoredTurnId };
    });
  }

  /** AiResolutionService 在 formal apply tx 内创建 automatic 存档（本方法不自开事务）。
   *  archiveId 由调用方预生成并传入，保证 `turn.resolved` 事件携带的 archiveId 与正式存档 id 一致。 */
  async createAutomatic(
    tx: QueryExecutor,
    campaignId: string,
    resolvedTurnId: string,
    actorUserId: string,
    archiveId: string,
  ): Promise<Archive> {
    const repo = new ArchiveRepository(tx);
    const version = await repo.nextVersion(tx, campaignId);
    const snapshot = await this.captureSnapshot(tx, campaignId, { forResolvedTurn: true, resolvedTurnId });
    const row = this.buildRow(campaignId, 'automatic', resolvedTurnId, null, version, snapshot, actorUserId, archiveId);
    await repo.insert(tx, row);
    return mapArchive(row);
  }

  async listForCampaign(ctx: CampaignAuthContext): Promise<Archive[]> {
    requireOwner(ctx); // 存档列表 owner-only
    const rows = await this.repository.listByCampaign(ctx.campaignId);
    return rows.map(mapArchive);
  }

  /** 快照：schemaVersion=2，含 campaignId/ruleset/characters(全部角色完整 owner current state)/active world facts/current turn+actions+requirements/全部 unsuperseded encounters+combatants/watermarks。
   *  watermarks 含 outboxSequence/aiRunCampaignSequence/turnNumber（turnNumber 为捕获时 unsuperseded 历史最大
   *  turn number，供 restore 决定 turns 的 supersede 水位；setup 无回合 = 0）。 */
  private async captureSnapshot(
    tx: QueryExecutor,
    campaignId: string,
    opts: { forResolvedTurn: boolean; resolvedTurnId?: string },
  ): Promise<ArchiveSnapshotV2> {
    const campaign = (await tx.query<{ id: string; ruleset: string }>(
      'SELECT id, ruleset FROM campaigns WHERE id = ?', [campaignId],
    ))[0];
    const chars = new CharacterRepository(tx);
    const facts = new WorldFactRepository(tx);
    const turns = new TurnRepository(tx);
    const archiveRepo = new ArchiveRepository(tx);
    const combatRepo = new CombatRepository(tx);

    // 快照角色取 campaign 全部角色（draft/pending_review/rejected/approved/archived 全保留），
    // 完整 owner current state。context builder 仍只取 approved——二者解耦。
    const characterRows = (await chars.listByCampaign(campaignId)).map(toSnapshotCharacter);
    // 快照事实取 active 全量（含 public/player_private/owner_only，恢复时按原 visibility 还原）。
    const factRows = (await facts.listByCampaign(campaignId)).map(toSnapshotWorldFact);

    let currentTurnSnapshot: ArchiveSnapshotV2['currentTurn'] = null;
    if (opts.forResolvedTurn && opts.resolvedTurnId) {
      // automatic：resolved turn 已 completed、entries 已写、下一回合尚未创建。
      currentTurnSnapshot = await this.turnSnapshot(tx, campaignId, opts.resolvedTurnId);
    } else {
      const active = await turns.findUnfinishedTurn(campaignId);
      if (active) {
        currentTurnSnapshot = await this.turnSnapshot(tx, campaignId, active.id);
      }
    }

    // 战斗快照：全部 unsuperseded encounters（含 completed 历史）+ 各自 unsuperseded combatants。
    const encounterRows = await combatRepo.listAllEncountersByCampaign(campaignId);
    const encounters: ArchiveSnapshotV2['encounters'] = [];
    for (const encounter of encounterRows) {
      encounters.push({
        encounter: {
          id: encounter.id, campaignId: encounter.campaign_id, name: encounter.name,
          status: encounter.status, activeCombatantId: encounter.active_combatant_id,
          round: encounter.round, createdAt: encounter.created_at, updatedAt: encounter.updated_at,
        },
        combatants: (await combatRepo.listAllCombatantsByEncounter(encounter.id)).map(toSnapshotCombatant),
      });
    }

    return {
      schemaVersion: 2,
      campaignId,
      ruleset: campaign.ruleset,
      characters: characterRows,
      worldFacts: factRows,
      currentTurn: currentTurnSnapshot,
      encounters,
      watermarks: {
        outboxSequence: await archiveRepo.maxOutboxSequence(campaignId),
        aiRunCampaignSequence: await archiveRepo.maxAiRunSequence(campaignId),
        // 捕获时 unsuperseded 历史最大 turn number：setup 无回合 = 0；idle-after-completed 快照
        // 的 currentTurn=null 但 turnNumber=N（恢复时保留 <=N 的 completed 历史，只 supersede >N）。
        // 注意：这是恢复时 turns 的 supersede 水位，与 maxTurnNumber（含 superseded，防号码复用）语义不同。
        turnNumber: await new TurnRepository(tx).maxActiveTurnNumber(campaignId),
      },
    };
  }

  private async turnSnapshot(tx: QueryExecutor, campaignId: string, turnId: string): Promise<NonNullable<ArchiveSnapshot['currentTurn']>> {
    const turns = new TurnRepository(tx);
    const turn = (await turns.findTurnById(turnId)) as TurnRow;
    const actions = (await turns.listActionsByTurn(turnId)).map(mapAction);
    const requirements = (await turns.listRequirements(turnId)).map((r) => ({ playerId: r.player_id, submitted: r.submitted === 1 }));
    return { turn: mapTurnSummary(turn), actions, requirements };
  }

  private buildRow(
    campaignId: string,
    kind: ArchiveKind,
    turnId: string | null,
    label: string | null,
    version: number,
    snapshot: ArchiveSnapshot,
    actorUserId: string,
    archiveId: string,
  ): ArchiveRow {
    return {
      id: archiveId, campaign_id: campaignId, kind, turn_id: turnId, label, version,
      state_json: JSON.stringify(snapshot), created_by_user_id: actorUserId,
      superseded_at: null, superseded_by_archive_id: null, created_at: new Date().toISOString(),
    };
  }

  /** 恢复时先 supersede 旧历史（顺序：outbox → AI runs/entries/requests → turns → archives → world facts → characters archived）。 */
  private async supersedeHistory(
    tx: QueryExecutor,
    campaignId: string,
    archiveId: string,
    restoredVersion: number,
    snapshot: ArchiveSnapshot,
    now: string,
  ): Promise<void> {
    await tx.execute(
      'UPDATE platform_outbox_events SET superseded_at = ?, superseded_by_archive_id = ? WHERE campaign_id = ? AND superseded_at IS NULL AND sequence > ?',
      [now, archiveId, campaignId, snapshot.watermarks.outboxSequence],
    );
    await new AiRunRepository(tx).supersedeByWatermark(tx, campaignId, archiveId, snapshot.watermarks.aiRunCampaignSequence, now);
    // 统一用 supersedeTurnsAfterNumber(turnNumber) 处理回合历史：turnNumber 是捕获时 unsuperseded
    // 历史最大 turn number（setup 无回合 = 0）。setup 快照（turnNumber=0）→ 所有回合 number>0
    // 全部 supersede（等效全量 supersede）；idle-after-completed 快照（currentTurn=null, turnNumber=N）
    // → 只 supersede number>N 的 later turns，保留 <=N 的既有 completed 历史。
    const turns = new TurnRepository(tx);
    await turns.supersedeTurnsAfterNumber(campaignId, snapshot.watermarks.turnNumber, archiveId, now);
    // 比被恢复存档更新的 archives（version 更大）一律 supersede；version counter 永不回退。
    await tx.execute(
      'UPDATE platform_archives SET superseded_at = ?, superseded_by_archive_id = ? WHERE campaign_id = ? AND superseded_at IS NULL AND version > ?',
      [now, archiveId, campaignId, restoredVersion],
    );
    const facts = new WorldFactRepository(tx);
    await facts.supersedeFactsNotIn(campaignId, snapshot.worldFacts.map((f) => f.id), archiveId, now);
    // 战斗历史：v2 只 supersede 快照外的 encounter/combatant；v1 视为“当时尚无平台战斗”，
    // 当前 unsuperseded 战斗全部标记为快照后历史。
    const combat = new CombatRepository(tx);
    if (snapshot.schemaVersion === 2) {
      await combat.supersedeNotIn(
        campaignId,
        snapshot.encounters.map((e) => e.encounter.id),
        snapshot.encounters.flatMap((e) => e.combatants.map((c) => c.id)),
        archiveId,
        now,
      );
    } else {
      await combat.supersedeAllByCampaign(campaignId, archiveId, now);
    }
  }

  /** 恢复快照状态：characters upsert + archive_restore audits；world facts upsert + 清除 superseded；currentTurn 恢复；completed 快照创建新 waiting turn（null 快照不开新回合）。 */
  private async restoreSnapshotState(
    tx: QueryExecutor,
    campaignId: string,
    snapshot: ArchiveSnapshot,
    actorUserId: string,
    now: string,
  ): Promise<string | null> {
    const chars = new CharacterRepository(tx);
    const facts = new WorldFactRepository(tx);
    const turns = new TurnRepository(tx);

    // 快照外角色一律 archived；快照内角色按原状态/字段 upsert + archive_restore audit。
    // archiveCharactersNotIn 每个真实状态变化（archived）也写 character audit，actor=owner。
    const keptCharacterIds = snapshot.characters.map((c) => c.id);
    await chars.archiveCharactersNotIn(tx, campaignId, keptCharacterIds, now, actorUserId);
    for (const snapshotChar of snapshot.characters) {
      const before = await chars.findById(snapshotChar.id);
      const row: CharacterRow = {
        id: snapshotChar.id, campaign_id: snapshotChar.campaignId, player_id: snapshotChar.playerId,
        name: snapshotChar.name, status: snapshotChar.status, sheet_json: JSON.stringify(snapshotChar.sheet),
        derived_json: JSON.stringify(snapshotChar.derived), submitted_at: snapshotChar.submittedAt,
        approved_at: snapshotChar.approvedAt, created_at: snapshotChar.createdAt, updated_at: now,
      };
      await chars.upsertRestored(row);
      await chars.insertAudit({
        id: nanoid(24), character_id: row.id, campaign_id: campaignId, actor_user_id: actorUserId,
        action: 'archive_restore', before_json: before ? JSON.stringify(before) : null,
        after_json: JSON.stringify(row), created_at: now,
      });
    }

    // 快照内事实 upsert + 清 superseded（快照外事实已在 supersedeHistory 中 supersede，这里不重复操作）。
    for (const snapshotFact of snapshot.worldFacts) {
      await facts.upsertRestored({
        id: snapshotFact.id, campaign_id: snapshotFact.campaignId, title: snapshotFact.title,
        kind: snapshotFact.kind, content: snapshotFact.content, visibility: snapshotFact.visibility,
        known_by_json: JSON.stringify(snapshotFact.knownBy), created_at: snapshotFact.createdAt,
        updated_at: now,
      });
    }

    // 战斗状态（v2）：快照内 encounters/combatants upsert 并解除 superseded。
    // 两阶段 position 重排避免 UNIQUE(encounter_id, position) 瞬时冲突：先把该 encounter
    // 现有（含 superseded 历史）positions 整体加安全 offset，再 upsert 快照最终 0..n-1。
    if (snapshot.schemaVersion === 2) {
      const combat = new CombatRepository(tx);
      for (const entry of snapshot.encounters) {
        const enc = entry.encounter;
        await combat.upsertRestoredEncounter({
          id: enc.id, campaign_id: enc.campaignId, name: enc.name, status: enc.status,
          active_combatant_id: enc.activeCombatantId, round: enc.round,
          superseded_at: null, superseded_by_archive_id: null,
          created_at: enc.createdAt, updated_at: now,
        });
        await combat.offsetAllPositionsIncludingSuperseded(enc.id, POSITION_RESTORE_OFFSET);
        for (const combatant of entry.combatants) {
          await combat.upsertRestoredCombatant({
            id: combatant.id, encounter_id: combatant.encounterId, campaign_id: combatant.campaignId,
            character_id: combatant.characterId, name: combatant.name, initiative: combatant.initiative,
            initiative_bonus: combatant.initiativeBonus, hp_current: combatant.hpCurrent,
            hp_max: combatant.hpMax, ac: combatant.ac,
            conditions_json: JSON.stringify(combatant.conditions), visibility: combatant.visibility,
            target_player_id: combatant.targetPlayerId, position: combatant.position,
            superseded_at: null, superseded_by_archive_id: null,
            created_at: combatant.createdAt, updated_at: now,
          });
        }
      }
    }

    // currentTurn 恢复。
    const current = snapshot.currentTurn;
    if (!current) {
      // 快照无 currentTurn（setup 或 idle-after-completed）：不开新回合。
      // supersede 语义已由 supersedeHistory 按 turnNumber watermark 完成——
      // setup(turnNumber=0) supersede 全部 later turns；idle-after-completed(turnNumber=N)
      // 保留 <=N 历史。这里只恢复 characters/worldFacts，不创建/恢复任何回合。
      return null;
    }
    const existing = await turns.findByNumber(campaignId, current.turn.number);
    if (existing) {
      // 恢复现有回合的状态字段（已完成行可能需恢复为 locked/waiting/needs_owner_attention），
      // 再替换 actions/requirements。绝不清 superseded_by_archive_id 之外的字段。
      await turns.clearSuperseded(existing.id);
      await turns.restoreTurnState(existing.id, {
        status: current.turn.status,
        lockedAt: current.turn.lockedAt,
        completedAt: current.turn.completedAt,
        updatedAt: now,
      });
      await turns.replaceActions(existing.id, campaignId, current.actions.map((a) => fromSnapshotAction(existing.id, campaignId, a)));
      await turns.replaceRequirements(existing.id, campaignId, current.requirements.map((r) => fromSnapshotRequirement(existing.id, campaignId, r)));
    } else {
      await turns.insertTurn({
        id: current.turn.id, campaign_id: campaignId, number: current.turn.number, status: current.turn.status,
        locked_at: current.turn.lockedAt, completed_at: current.turn.completedAt,
        created_at: current.turn.createdAt, updated_at: now,
      });
      await turns.replaceActions(current.turn.id, campaignId, current.actions.map((a) => fromSnapshotAction(current.turn.id, campaignId, a)));
      await turns.replaceRequirements(current.turn.id, campaignId, current.requirements.map((r) => fromSnapshotRequirement(current.turn.id, campaignId, r)));
    }

    // restoredTurnId 必须是实际落库的 turn id：同 number 已有 replacement id（快照 turn id 已删除、
    // 新 id 占位同号）时返回 existing.id，而非快照里的 current.turn.id；insert 新行时返回快照 id。
    // completed 快照下方单独返回新 waiting turn id。
    const restoredTurnId = existing ? existing.id : current.turn.id;

    if (current.turn.status === 'completed') {
      // completed 快照：同 tx 创建新 waiting turn，number = 全局 MAX+1（含 superseded，不复用）。
      const number = (await turns.maxTurnNumber(campaignId)) + 1;
      const newTurnId = nanoid(24);
      await turns.insertTurn({
        id: newTurnId, campaign_id: campaignId, number, status: 'waiting_for_actions',
        locked_at: null, completed_at: null, created_at: now, updated_at: now,
      });
      // 新 waiting turn requirements 只取快照中 status='approved' 的 playerId（distinct）；
      // draft/pending/rejected/archived 不是必需玩家（Task 3 archive.test 直接断言该行为）。
      const approvedPlayerIds = snapshot.characters
        .filter((c) => c.status === 'approved')
        .map((c) => c.playerId);
      for (const playerId of [...new Set(approvedPlayerIds)]) {
        await turns.insertRequirement(newTurnId, campaignId, playerId);
      }
      return newTurnId;
    }
    // waiting/locked/needs_owner_attention 快照：恢复该状态，不自动开新回合。
    // 返回实际落库的 turn id（existing-by-number 路径返回 existing.id）。
    return restoredTurnId;
  }
}

function mapArchive(row: ArchiveRow): Archive {
  return {
    id: row.id, campaignId: row.campaign_id, kind: row.kind, turnId: row.turn_id,
    label: row.label, version: row.version, superseded: row.superseded_at != null,
    createdByUserId: row.created_by_user_id, createdAt: row.created_at,
  };
}

/** CharacterRow → 快照角色：保留 status/submitted_at/approved_at 完整 owner current state；不含 *_json 内部字段。 */
function toSnapshotCharacter(row: CharacterRow): ArchiveSnapshotCharacter {
  return {
    id: row.id, campaignId: row.campaign_id, playerId: row.player_id, name: row.name,
    status: row.status, sheet: JSON.parse(row.sheet_json) as Record<string, unknown>,
    derived: JSON.parse(row.derived_json) as Record<string, unknown>,
    submittedAt: row.submitted_at, approvedAt: row.approved_at,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

/** WorldFactRow → 快照事实：与 WorldFact DTO 同形，不含 *_json 内部字段。 */
function toSnapshotWorldFact(row: WorldFactRow): ArchiveSnapshot['worldFacts'][number] {
  return {
    id: row.id, campaignId: row.campaign_id, title: row.title, kind: row.kind,
    content: row.content, visibility: row.visibility,
    knownBy: JSON.parse(row.known_by_json) as string[],
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

/** CombatantRow → 快照战斗员：无 superseded 字段，恢复时按快照语义 upsert。 */
function toSnapshotCombatant(row: CombatantRow): ArchiveSnapshotV2['encounters'][number]['combatants'][number] {
  return {
    id: row.id, encounterId: row.encounter_id, campaignId: row.campaign_id,
    characterId: row.character_id, name: row.name, initiative: row.initiative,
    initiativeBonus: row.initiative_bonus, hpCurrent: row.hp_current, hpMax: row.hp_max,
    ac: row.ac, conditions: JSON.parse(row.conditions_json) as string[],
    visibility: row.visibility, targetPlayerId: row.target_player_id, position: row.position,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

function mapTurnSummary(row: TurnRow): NonNullable<ArchiveSnapshot['currentTurn']>['turn'] {
  return {
    id: row.id, campaignId: row.campaign_id, number: row.number, status: row.status,
    lockedAt: row.locked_at, completedAt: row.completed_at, createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapAction(row: ActionRow): TurnAction {
  return {
    id: row.id, turnId: row.turn_id, campaignId: row.campaign_id, playerId: row.player_id,
    body: row.body, submittedAt: row.submitted_at, updatedAt: row.updated_at,
  };
}

/** 快照 action → 目标恢复 turn 的 ActionRow：turn_id 固定为目标 turn，campaign_id 固定为目标 campaign。 */
function fromSnapshotAction(turnId: string, campaignId: string, action: TurnAction): ActionRow {
  return {
    id: action.id, turn_id: turnId, campaign_id: campaignId, player_id: action.playerId,
    body: action.body, submitted_at: action.submittedAt, updated_at: action.updatedAt,
  };
}

/** 快照 requirement → 目标恢复 turn 的 RequirementRow：turn_id/campaign_id 固定为目标 turn/campaign。 */
function fromSnapshotRequirement(turnId: string, campaignId: string, requirement: ArchiveSnapshotRequirement): RequirementRow {
  return {
    turn_id: turnId, campaign_id: campaignId, player_id: requirement.playerId,
    submitted: requirement.submitted ? 1 : 0,
  };
}
