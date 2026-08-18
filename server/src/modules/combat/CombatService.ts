import { nanoid } from 'nanoid';
import {
  combatCommandSchema,
  startEncounterInputSchema,
  type CombatCommand,
  type Encounter,
  type StartEncounterInput,
} from '@dnd/contracts';
import type { DatabasePort, QueryExecutor } from '../../platform/database/DatabasePort.js';
import type { EventPublisherPort } from '../../platform/events/EventPublisherPort.js';
import { AppError } from '../../platform/http/AppError.js';
import { requireOwner, type CampaignAuthContext } from '../campaigns/CampaignAccess.js';
import { canRead } from '../visibility/VisibilityPolicy.js';
import { CombatRepository, type CombatantRow, type EncounterRow } from './CombatRepository.js';
import { CampaignMutationCoordinator } from '../campaigns/CampaignMutationCoordinator.js';
import { ActorService } from '../actors/ActorService.js';
import { ActorRuntimeStateService } from '../actors/ActorRuntimeStateService.js';

export interface CombatCommandPort {
  applyIn(
    tx: QueryExecutor,
    campaignId: string,
    encounterId: string,
    command: CombatCommand,
  ): Promise<Encounter>;
  /** 创建遭遇核心（owner start 与 AI encounterStarts 共用）：使用调用方 tx，不自行开事务。 */
  createIn(
    tx: QueryExecutor,
    campaignId: string,
    input: StartEncounterInput,
  ): Promise<Encounter>;
}

/** 位置重排两阶段安全 offset：远大于任何真实 position 数量，杜绝 UNIQUE 瞬时冲突。 */
const POSITION_REORDER_OFFSET = 1_000_000;

/**
 * CombatService：结构化遭遇与白名单战斗命令的唯一执行者。
 * 每个 HTTP 写命令都在单个 transaction 内完成 campaign 行锁、active-only 校验、
 * 命令应用与 combat.updated publish；applyIn 只复用调用方（AI formal apply）tx。
 * 所有骰子由注入的 random() 产生，HTTP/AI 不得自报 roll/total。
 */
export class CombatService implements CombatCommandPort {
  private readonly repository: CombatRepository;
  private readonly mutations: CampaignMutationCoordinator;
  private readonly actors: ActorService;
  private readonly runtime: ActorRuntimeStateService;

  constructor(
    private readonly executor: DatabasePort,
    private readonly outbox: EventPublisherPort,
    private readonly random: () => number = Math.random,
    mutations?: CampaignMutationCoordinator,
    actors?: ActorService,
    runtime?: ActorRuntimeStateService,
  ) {
    this.repository = new CombatRepository(executor);
    this.mutations = mutations ?? new CampaignMutationCoordinator(executor);
    this.actors = actors ?? new ActorService(executor, this.mutations);
    this.runtime = runtime ?? new ActorRuntimeStateService(executor, this.mutations);
  }

  /** owner 创建 preparation encounter；同战役最多一个未完成 encounter。 */
  async start(ctx: CampaignAuthContext, input: StartEncounterInput): Promise<Encounter> {
    requireOwner(ctx);
    const parsed = startEncounterInputSchema.parse(input);
    return this.executor.transaction(async (tx) => {
      const execution = await this.mutations.mutateIn(tx, {
        campaignId: ctx.campaignId,
        mutationId: `combat-start:${nanoid(24)}`,
        causeType: 'combat_start',
      }, async ({ stateRevision }) => {
        await tx.execute('UPDATE campaigns SET updated_at = updated_at WHERE id = ?', [ctx.campaignId]);
        return this.createIn(tx, ctx.campaignId, parsed, stateRevision);
      });
      if (!execution.result) throw new AppError('INTERNAL_ERROR', '遭遇创建结果读取失败。');
      return execution.result;
    });
  }

  /** 创建遭遇核心（owner start 与 AI encounterStarts 共用）：不自行开事务，使用调用方 tx。
   *  先校验角色/成员归属，再写 encounter/combatants，并同 tx 发布 combat.updated。 */
  async createIn(tx: QueryExecutor, campaignId: string, input: StartEncounterInput, stateRevision = 0): Promise<Encounter> {
    const repo = new CombatRepository(tx);
    if (await repo.findUnfinishedEncounter(campaignId)) {
      throw new AppError('STATE_CONFLICT', '已有进行中的遭遇。');
    }
    await this.validateCombatants(tx, campaignId, input);
    const now = new Date().toISOString();
    const encounterId = nanoid(24);
    await repo.insertEncounter({
      id: encounterId, campaign_id: campaignId, name: input.name, status: 'preparation',
      active_combatant_id: null, round: 1, superseded_at: null, superseded_by_archive_id: null,
      created_at: now, updated_at: now,
    });
    for (let index = 0; index < input.combatants.length; index += 1) {
      const combatant = input.combatants[index];
      await repo.insertCombatant({
        id: nanoid(24), encounter_id: encounterId, campaign_id: campaignId,
        actor_id: await this.resolveCombatantActorIn(tx, campaignId, combatant, stateRevision),
        character_id: combatant.characterId, name: combatant.name, initiative: null,
        initiative_bonus: combatant.initiativeBonus, hp_current: combatant.hpCurrent,
        hp_max: combatant.hpMax, ac: combatant.ac,
        conditions_json: JSON.stringify([...new Set(combatant.conditions.map((c) => c.trim()))]),
        visibility: combatant.visibility, target_player_id: combatant.targetPlayerId,
        position: index, superseded_at: null, superseded_by_archive_id: null,
        created_at: now, updated_at: now,
      });
    }
    await this.outbox.publishIn(tx, { type: 'combat.updated', campaignId, encounterId });
    return this.loadOwnerView(tx, campaignId, encounterId);
  }

  /** owner 执行白名单命令（HTTP 路由调用）；start_encounter 只经 start()。 */
  async execute(ctx: CampaignAuthContext, encounterId: string, command: CombatCommand): Promise<Encounter> {
    requireOwner(ctx);
    return this.executor.transaction(async (tx) => {
      const execution = await this.mutations.mutateIn(tx, {
        campaignId: ctx.campaignId,
        mutationId: `combat-command:${nanoid(24)}`,
        causeType: 'combat_command',
        causeId: encounterId,
      }, async ({ stateRevision }) => {
        await tx.execute('UPDATE campaigns SET updated_at = updated_at WHERE id = ?', [ctx.campaignId]);
        const encounter = await this.applyCommand(tx, ctx.campaignId, encounterId, command, stateRevision);
        return this.loadOwnerView(tx, ctx.campaignId, encounter.id);
      });
      if (!execution.result) throw new AppError('INTERNAL_ERROR', '战斗命令结果读取失败。');
      return execution.result;
    });
  }

  /** AI 路径：在调用方 formal apply tx 内复用同一白名单命令端口，不再开 transaction。 */
  async applyIn(tx: QueryExecutor, campaignId: string, encounterId: string, command: CombatCommand): Promise<Encounter> {
    const revisionRows = await tx.query<{ revision: number }>('SELECT revision FROM platform_campaign_state_heads WHERE campaign_id = ?', [campaignId]);
    const stateRevision = Number(revisionRows[0]?.revision ?? 0);
    const encounter = await this.applyCommand(tx, campaignId, encounterId, command, stateRevision);
    return this.loadOwnerView(tx, campaignId, encounter.id);
  }

  async get(ctx: CampaignAuthContext, encounterId: string): Promise<Encounter> {
    const encounter = await this.repository.findEncounterById(encounterId);
    if (!encounter || encounter.campaign_id !== ctx.campaignId) {
      throw new AppError('NOT_FOUND', '遭遇不存在。');
    }
    return this.project(encounter, await this.repository.listCombatantsByEncounter(encounterId), ctx);
  }

  async list(ctx: CampaignAuthContext): Promise<Encounter[]> {
    const encounters = await this.repository.listEncountersByCampaign(ctx.campaignId);
    const result: Encounter[] = [];
    for (const encounter of encounters) {
      result.push(this.project(encounter, await this.repository.listCombatantsByEncounter(encounter.id), ctx));
    }
    return result;
  }

  // ---------- 命令应用（tx 内） ----------

  private async applyCommand(
    tx: QueryExecutor,
    campaignId: string,
    encounterId: string,
    command: CombatCommand,
    stateRevision: number,
  ): Promise<EncounterRow> {
    const parsed = combatCommandSchema.parse(command); // 严格白名单校验（含 payload strict）
    const repo = new CombatRepository(tx);
    const encounter = await repo.findEncounterById(encounterId);
    if (!encounter || encounter.campaign_id !== campaignId) {
      throw new AppError('NOT_FOUND', '遭遇不存在。');
    }
    const combatants = await repo.listCombatantsByEncounter(encounterId);
    const now = new Date().toISOString();
    let next: EncounterRow;
    switch (parsed.kind) {
      case 'start_encounter':
        throw new AppError('VALIDATION_ERROR', 'start_encounter 只能通过 start 创建遭遇。');
      case 'roll_initiative':
        next = await this.rollInitiative(repo, encounter, combatants, now);
        break;
      case 'advance_turn':
        next = await this.advanceTurn(repo, encounter, combatants, now);
        break;
      case 'apply_attack':
        next = await this.applyAttack(repo, encounter, combatants, parsed.payload, now, stateRevision);
        break;
      case 'apply_saving_throw':
        next = await this.applySavingThrow(repo, encounter, combatants, parsed.payload, now, stateRevision);
        break;
      case 'apply_damage':
        next = await this.applyAmount(repo, encounter, combatants, parsed.payload.actorCombatantId, parsed.payload.targetCombatantId, -parsed.payload.amount, now, stateRevision);
        break;
      case 'apply_healing':
        next = await this.applyAmount(repo, encounter, combatants, parsed.payload.actorCombatantId, parsed.payload.targetCombatantId, parsed.payload.amount, now, stateRevision);
        break;
      case 'add_condition':
        next = await this.applyCondition(repo, encounter, combatants, parsed.payload.actorCombatantId, parsed.payload.targetCombatantId, parsed.payload.condition, true, now, stateRevision);
        break;
      case 'remove_condition':
        next = await this.applyCondition(repo, encounter, combatants, parsed.payload.actorCombatantId, parsed.payload.targetCombatantId, parsed.payload.condition, false, now, stateRevision);
        break;
      case 'end_encounter':
        next = await this.endEncounter(repo, encounter, now);
        break;
    }
    await this.outbox.publishIn(tx, { type: 'combat.updated', campaignId, encounterId: next.id });
    return next;
  }

  private async rollInitiative(
    repo: CombatRepository,
    encounter: EncounterRow,
    combatants: CombatantRow[],
    now: string,
  ): Promise<EncounterRow> {
    if (encounter.status !== 'preparation') {
      throw new AppError('STATE_CONFLICT', '只有 preparation 遭遇可以掷先攻。');
    }
    const rolled = combatants.map((c) => ({
      row: c,
      total: this.d20() + c.initiative_bonus,
    }));
    // 稳定排序：total desc，平手按原 position 升序（sort 稳定 + 原序保证）。
    rolled.sort((a, b) => b.total - a.total || a.row.position - b.row.position);
    // 两阶段重排：整体加 offset 再写最终 0..n-1，避免 UNIQUE(encounter_id, position) 瞬时冲突。
    await repo.offsetAllPositions(encounter.id, POSITION_REORDER_OFFSET);
    for (let index = 0; index < rolled.length; index += 1) {
      const item = rolled[index];
      await repo.updateCombatant({ ...item.row, initiative: item.total, position: index, updated_at: now });
    }
    const activeId = rolled[0]?.row.id ?? null;
    const updated: EncounterRow = { ...encounter, status: 'active', active_combatant_id: activeId, round: 1, updated_at: now };
    await repo.updateEncounter(updated, 'preparation');
    return updated;
  }

  private async advanceTurn(
    repo: CombatRepository,
    encounter: EncounterRow,
    combatants: CombatantRow[],
    now: string,
  ): Promise<EncounterRow> {
    if (encounter.status !== 'active' || combatants.length === 0) {
      throw new AppError('STATE_CONFLICT', '只有 active 遭遇可以推进回合。');
    }
    const currentIndex = combatants.findIndex((c) => c.id === encounter.active_combatant_id);
    const nextIndex = (currentIndex + 1) % combatants.length;
    const wraps = nextIndex === 0;
    const updated: EncounterRow = {
      ...encounter, active_combatant_id: combatants[nextIndex].id,
      round: wraps ? encounter.round + 1 : encounter.round, updated_at: now,
    };
    await repo.updateEncounter(updated, 'active');
    return updated;
  }

  private async applyAttack(
    repo: CombatRepository,
    encounter: EncounterRow,
    combatants: CombatantRow[],
    payload: { actorCombatantId: string; targetCombatantId: string; attackBonus: number; damageDie: string; damageDice: number; damageBonus: number },
    now: string,
    stateRevision: number,
  ): Promise<EncounterRow> {
    this.assertActiveActor(encounter, combatants, payload.actorCombatantId);
    const target = this.findCombatant(combatants, payload.targetCombatantId);
    const attackRoll = this.d20() + payload.attackBonus;
    if (attackRoll >= target.ac) {
      const dieSize = Number(payload.damageDie.slice(1));
      let diceTotal = 0;
      for (let i = 0; i < payload.damageDice; i += 1) {
        diceTotal += Math.floor(this.random() * dieSize) + 1;
      }
      const total = Math.max(0, diceTotal + payload.damageBonus); // 负总值不得治疗
      await this.applyDelta(repo, target, -total, now, undefined, stateRevision);
    }
    return encounter;
  }

  private async applySavingThrow(
    repo: CombatRepository,
    encounter: EncounterRow,
    combatants: CombatantRow[],
    payload: { actorCombatantId: string; targetCombatantId: string; saveBonus: number; dc: number; damageOnFailure: number },
    now: string,
    stateRevision: number,
  ): Promise<EncounterRow> {
    this.assertActiveActor(encounter, combatants, payload.actorCombatantId);
    const target = this.findCombatant(combatants, payload.targetCombatantId);
    const saveRoll = this.d20() + payload.saveBonus;
    if (saveRoll < payload.dc) {
      await this.applyDelta(repo, target, -payload.damageOnFailure, now, undefined, stateRevision);
    }
    return encounter;
  }

  private async applyAmount(
    repo: CombatRepository,
    encounter: EncounterRow,
    combatants: CombatantRow[],
    actorId: string,
    targetId: string,
    delta: number,
    now: string,
    stateRevision: number,
  ): Promise<EncounterRow> {
    this.assertActiveActor(encounter, combatants, actorId);
    const target = this.findCombatant(combatants, targetId);
    await this.applyDelta(repo, target, delta, now, undefined, stateRevision);
    return encounter;
  }

  private async applyCondition(
    repo: CombatRepository,
    encounter: EncounterRow,
    combatants: CombatantRow[],
    actorId: string,
    targetId: string,
    condition: string,
    add: boolean,
    now: string,
    stateRevision: number,
  ): Promise<EncounterRow> {
    this.assertActiveActor(encounter, combatants, actorId);
    const target = this.findCombatant(combatants, targetId);
    const conditions = JSON.parse(target.conditions_json) as string[];
    const trimmed = condition.trim();
    if (add) {
      if (!conditions.includes(trimmed)) {
        conditions.push(trimmed);
      }
    } else {
      const index = conditions.indexOf(trimmed);
      if (index >= 0) {
        conditions.splice(index, 1);
      }
    }
    await this.applyDelta(repo, target, 0, now, conditions, stateRevision);
    return encounter;
  }

  private async endEncounter(repo: CombatRepository, encounter: EncounterRow, now: string): Promise<EncounterRow> {
    if (encounter.status === 'completed') {
      throw new AppError('STATE_CONFLICT', '遭遇已经结束。');
    }
    const updated: EncounterRow = { ...encounter, status: 'completed', active_combatant_id: null, updated_at: now };
    await repo.updateEncounter(updated, encounter.status);
    return updated;
  }

  private async applyDelta(
    repo: CombatRepository,
    target: CombatantRow,
    delta: number,
    now: string,
    conditions?: string[],
    stateRevision = 0,
  ): Promise<void> {
    let hpCurrent = Math.max(0, Math.min(target.hp_max, target.hp_current + delta));
    let runtimeConditions = conditions ?? parseConditions(target.conditions_json);
    if (target.actor_id) {
      const effects: import('@dnd/contracts').RuntimeMutationEffect[] = [];
      if (delta < 0) effects.push({ kind: 'damage', amount: -delta });
      if (delta > 0) effects.push({ kind: 'healing', amount: delta });
      if (conditions) {
        const previous = new Set(parseConditions(target.conditions_json));
        for (const condition of conditions) {
          if (!previous.has(condition)) effects.push({ kind: 'add_condition', condition });
        }
        for (const condition of previous) {
          if (!conditions.includes(condition)) effects.push({ kind: 'remove_condition', condition });
        }
      }
      const state = await this.runtime.applyEffectsIn(repo.executor, target.campaign_id, target.actor_id, effects, stateRevision);
      hpCurrent = Math.min(target.hp_max, state.currentHp);
      runtimeConditions = state.conditions;
    }
    await repo.updateCombatant({
      ...target,
      hp_current: hpCurrent,
      conditions_json: JSON.stringify(runtimeConditions),
      updated_at: now,
    });
  }

  private assertActiveActor(encounter: EncounterRow, combatants: CombatantRow[], actorId: string): void {
    if (encounter.status !== 'active' || encounter.active_combatant_id == null) {
      throw new AppError('STATE_CONFLICT', '遭遇尚未进入行动阶段。');
    }
    if (actorId !== encounter.active_combatant_id) {
      throw new AppError('STATE_CONFLICT', '只有当前行动的战斗员可以执行命令。');
    }
    this.findCombatant(combatants, actorId);
  }

  private findCombatant(combatants: CombatantRow[], id: string): CombatantRow {
    const combatant = combatants.find((c) => c.id === id);
    if (!combatant) {
      throw new AppError('NOT_FOUND', '战斗员不存在。');
    }
    return combatant;
  }

  private d20(): number {
    return Math.floor(this.random() * 20) + 1;
  }

  // ---------- 校验与投影 ----------

  private async resolveCombatantActorIn(
    tx: QueryExecutor,
    campaignId: string,
    input: StartEncounterInput['combatants'][number],
    stateRevision: number,
  ): Promise<string> {
    if (input.actorId) {
      return (await this.actors.assertActorIn(tx, campaignId, input.actorId)).id;
    }
    if (input.characterId) {
      const character = (await tx.query<import('../characters/CharacterRepository.js').CharacterRow>(
        'SELECT * FROM platform_characters WHERE id = ? AND campaign_id = ? AND status = ?',
        [input.characterId, campaignId, 'approved'],
      ))[0];
      if (!character) throw new AppError('VALIDATION_ERROR', '战斗员关联的角色必须属于本战役且已批准。');
      return (await this.actors.ensureCharacterActorIn(tx, character, stateRevision)).id;
    }
    const actor = await this.actors.createNpcIn(tx, campaignId, nanoid(24), {
      displayName: input.name, controlMode: 'ai', mechanicsMode: 'lightweight',
      currentHp: input.hpCurrent, temporaryHp: 0, conditions: input.conditions,
    }, stateRevision);
    return actor.id;
  }

  private async validateCombatants(tx: QueryExecutor, campaignId: string, input: StartEncounterInput): Promise<void> {
    const characterIds = [...new Set(input.combatants.map((c) => c.characterId).filter((id): id is string => id != null))];
    if (characterIds.length > 0) {
      const placeholders = characterIds.map(() => '?').join(',');
      const rows = await tx.query<{ id: string; campaign_id: string; status: string }>(
        `SELECT id, campaign_id, status FROM platform_characters WHERE id IN (${placeholders})`,
        characterIds,
      );
      const byId = new Map(rows.map((r) => [r.id, r]));
      for (const id of characterIds) {
        const row = byId.get(id);
        if (!row || row.campaign_id !== campaignId || row.status !== 'approved') {
          throw new AppError('VALIDATION_ERROR', '战斗员关联的角色必须属于本战役且已批准。');
        }
      }
    }
    const targetPlayerIds = [...new Set(input.combatants
      .filter((c) => c.visibility === 'player_private')
      .map((c) => c.targetPlayerId)
      .filter((id): id is string => id != null))];
    for (const playerId of targetPlayerIds) {
      const member = await tx.query<{ user_id: string }>(
        'SELECT user_id FROM campaign_members WHERE campaign_id = ? AND user_id = ? AND role = ?',
        [campaignId, playerId, 'player'],
      );
      if (member.length === 0) {
        throw new AppError('VALIDATION_ERROR', 'player_private 战斗员的目标玩家必须是本战役成员。');
      }
    }
  }

  private async loadOwnerView(tx: QueryExecutor, campaignId: string, encounterId: string): Promise<Encounter> {
    const repo = new CombatRepository(tx);
    const encounter = await repo.findEncounterById(encounterId);
    if (!encounter || encounter.campaign_id !== campaignId) {
      throw new AppError('NOT_FOUND', '遭遇不存在。');
    }
    return this.project(encounter, await repo.listCombatantsByEncounter(encounterId), {
      userId: '', campaignId, role: 'owner', playerId: null,
    });
  }

  private project(encounter: EncounterRow, combatants: CombatantRow[], ctx: CampaignAuthContext): Encounter {
    const viewer = { role: ctx.role, playerId: ctx.playerId };
    const visible = combatants.filter((c) => canRead(viewer, c.visibility, c.target_player_id ? [c.target_player_id] : []));
    const activeVisible = encounter.active_combatant_id != null && visible.some((c) => c.id === encounter.active_combatant_id);
    return {
      id: encounter.id,
      campaignId: encounter.campaign_id,
      name: encounter.name,
      status: encounter.status,
      activeCombatantId: activeVisible ? encounter.active_combatant_id : null,
      round: encounter.round,
      combatants: visible.map((c) => ({
        id: c.id,
        actorId: c.actor_id,
        name: c.name,
        characterId: c.character_id,
        initiative: c.initiative,
        initiativeBonus: c.initiative_bonus,
        hpCurrent: c.hp_current,
        hpMax: c.hp_max,
        ac: c.ac,
        conditions: JSON.parse(c.conditions_json) as string[],
        visibility: c.visibility,
        // 可见的 player_private 行只保留 viewer 自己的 targetPlayerId；public/owner_only 为 null。
        targetPlayerId: c.visibility === 'player_private' ? (viewer.role === 'owner' ? c.target_player_id : (viewer.playerId === c.target_player_id ? viewer.playerId : null)) : null,
      })),
      createdAt: encounter.created_at,
      updatedAt: encounter.updated_at,
    };
  }
}

function parseConditions(json: string): string[] {
  try {
    const value: unknown = JSON.parse(json);
    return Array.isArray(value) && value.every((item) => typeof item === 'string') ? [...new Set(value)] : [];
  } catch {
    return [];
  }
}
