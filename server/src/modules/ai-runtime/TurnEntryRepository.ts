import type { Visibility } from '@dnd/contracts';
import type { QueryExecutor } from '../../platform/database/DatabasePort.js';

export interface TurnEntryRow {
  id: string;
  ai_run_id: string;
  campaign_id: string;
  turn_id: string;
  entry_kind: 'narrative' | 'private_update' | 'dice_result';
  entry_index: number;
  visibility: Visibility;
  target_player_id: string | null;
  payload_json: string;
  created_at: string;
  superseded_at: string | null;
  superseded_by_archive_id: string | null;
}

export interface TurnEntryInsertRow {
  id: string;
  ai_run_id: string;
  campaign_id: string;
  turn_id: string;
  entry_kind: 'narrative' | 'private_update' | 'dice_result';
  entry_index: number;
  visibility: Visibility;
  target_player_id: string | null;
  payload_json: string;
  created_at: string;
}

export class TurnEntryRepository {
  constructor(private readonly executor: QueryExecutor) {}

  async insertEntry(tx: QueryExecutor, row: TurnEntryInsertRow): Promise<void> {
    await tx.execute(
      `INSERT INTO platform_turn_entries
        (id, ai_run_id, campaign_id, turn_id, entry_kind, entry_index, visibility, target_player_id, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.id, row.ai_run_id, row.campaign_id, row.turn_id, row.entry_kind, row.entry_index,
       row.visibility, row.target_player_id, row.payload_json, row.created_at],
    );
  }

  async insertInteractionRequest(tx: QueryExecutor, row: { id: string; provider_id: string; campaign_id: string; turn_id: string; ai_run_id: string; target_player_id: string; prompt: string; created_at: string }): Promise<void> {
    await tx.execute(
      `INSERT INTO platform_interaction_requests (id, provider_id, campaign_id, turn_id, ai_run_id, target_player_id, prompt, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      [row.id, row.provider_id, row.campaign_id, row.turn_id, row.ai_run_id, row.target_player_id, row.prompt, row.created_at],
    );
  }

  /** 默认 active 查询（owner 全量）。 */
  async listByTurn(turnId: string): Promise<TurnEntryRow[]> {
    return this.executor.query<TurnEntryRow>(
      'SELECT * FROM platform_turn_entries WHERE turn_id = ? AND superseded_at IS NULL ORDER BY entry_index ASC',
      [turnId],
    );
  }
}
