import type { QueryExecutor, QueryReader } from '../database/DatabasePort.js';

/** 稳定、coarse、不含敏感数据的 store 错误。 */
export class PlatformInstanceStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlatformInstanceStoreError';
  }
}

export type EnrollmentState = 'initializing' | 'ready';
export type MaintenanceState = 'active' | 'draining' | 'quiescent';
export type SessionSecurityState = 'pending' | 'cleaning' | 'ready';
export type EnrollmentKeyOrigin = 'generated' | 'preexisting';

export interface PlatformInstanceRow {
  database_id: string;
  enrollment_state: EnrollmentState;
  credential_key_fingerprint: string;
  enrollment_key_origin: EnrollmentKeyOrigin;
  bootstrap_completed_at: string | null;
  maintenance_state: MaintenanceState;
  maintenance_epoch: number;
  platform_rules_revision: number;
  session_security_state: SessionSecurityState;
  session_security_cutover_at: string | null;
  created_at: string;
  updated_at: string;
}

interface InstanceRowRaw {
  database_id: string;
  enrollment_state: string;
  credential_key_fingerprint: string;
  enrollment_key_origin: string;
  bootstrap_completed_at: string | null;
  maintenance_state: string;
  maintenance_epoch: number;
  platform_rules_revision: number;
  session_security_state: string;
  session_security_cutover_at: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * 平台实例单例行 store：职责集中于 singleton/status 读取与条件 transition。
 *
 * 不生成 ID/key、不写文件、不自动修复。所有 transition 都是条件 update，
 * `changes === 1` 即 transition winner；状态/指纹不匹配一律抛
 * PlatformInstanceStoreError（调用方决定 fail closed 语义）。
 */
export class PlatformInstanceStore {
  async read(reader: QueryReader): Promise<PlatformInstanceRow | null> {
    const rows = await reader.query<InstanceRowRaw>(
      `SELECT database_id, enrollment_state, credential_key_fingerprint, enrollment_key_origin,
              bootstrap_completed_at, maintenance_state, maintenance_epoch,
              platform_rules_revision, session_security_state, session_security_cutover_at,
              created_at, updated_at
         FROM platform_instance WHERE singleton_id = 1`,
    );
    const row = rows[0];
    return row ? toInstanceRow(row) : null;
  }

  async insertInitializing(
    tx: QueryExecutor,
    input: { databaseId: string; keyFingerprint: string; keyOrigin: EnrollmentKeyOrigin; now: string },
  ): Promise<void> {
    const changes = await tx.execute(
      `INSERT INTO platform_instance
         (singleton_id, database_id, enrollment_state, credential_key_fingerprint,
          enrollment_key_origin, maintenance_state, maintenance_epoch, platform_rules_revision,
          session_security_state, created_at, updated_at)
       VALUES (1, ?, 'initializing', ?, ?, 'active', 0, 0, 'pending', ?, ?)`,
      [input.databaseId, input.keyFingerprint, input.keyOrigin, input.now, input.now],
    );
    if (changes.changes !== 1) {
      throw new PlatformInstanceStoreError('无法写入 platform_instance 单例行。');
    }
  }

  async markEnrollmentReady(tx: QueryExecutor, expectedFingerprint: string, now: string): Promise<void> {
    const changes = await tx.execute(
      `UPDATE platform_instance
          SET enrollment_state = 'ready', updated_at = ?
        WHERE singleton_id = 1 AND enrollment_state = 'initializing' AND credential_key_fingerprint = ?`,
      [now, expectedFingerprint],
    );
    if (changes.changes !== 1) {
      throw new PlatformInstanceStoreError('enrollment 状态推进失败：状态非 initializing 或指纹不匹配。');
    }
  }

  async rollbackInitializing(tx: QueryExecutor, expectedFingerprint: string): Promise<void> {
    const changes = await tx.execute(
      `DELETE FROM platform_instance
        WHERE singleton_id = 1 AND enrollment_state = 'initializing' AND credential_key_fingerprint = ?`,
      [expectedFingerprint],
    );
    if (changes.changes !== 1) {
      throw new PlatformInstanceStoreError('enrollment rollback 失败：行不存在、已 ready 或指纹不匹配。');
    }
  }

  async beginSessionCleaning(tx: QueryExecutor, now: string): Promise<void> {
    const changes = await tx.execute(
      `UPDATE platform_instance
          SET session_security_state = 'cleaning', session_security_cutover_at = ?, updated_at = ?
        WHERE singleton_id = 1 AND session_security_state = 'pending'`,
      [now, now],
    );
    if (changes.changes !== 1) {
      throw new PlatformInstanceStoreError('session security cutover 推进失败：状态非 pending。');
    }
  }

  async markSessionSecurityReady(tx: QueryExecutor, now: string): Promise<void> {
    const changes = await tx.execute(
      `UPDATE platform_instance
          SET session_security_state = 'ready', updated_at = ?
        WHERE singleton_id = 1 AND session_security_state = 'cleaning' AND session_security_cutover_at IS NOT NULL`,
      [now],
    );
    if (changes.changes !== 1) {
      throw new PlatformInstanceStoreError('session security 标记 ready 失败：状态非 cleaning 或缺少 cutover 时间戳。');
    }
  }

  async transitionMaintenance(
    tx: QueryExecutor,
    expectedState: MaintenanceState,
    expectedEpoch: number,
    nextState: MaintenanceState,
    now: string,
  ): Promise<void> {
    const changes = await tx.execute(
      `UPDATE platform_instance
          SET maintenance_state = ?, maintenance_epoch = maintenance_epoch + 1, updated_at = ?
        WHERE singleton_id = 1 AND maintenance_state = ? AND maintenance_epoch = ?`,
      [nextState, now, expectedState, expectedEpoch],
    );
    if (changes.changes !== 1) {
      throw new PlatformInstanceStoreError('maintenance transition 失败：state/epoch 与期望不匹配。');
    }
  }
}

function toInstanceRow(row: InstanceRowRaw): PlatformInstanceRow {
  if (
    (row.enrollment_state !== 'initializing' && row.enrollment_state !== 'ready')
    || (row.enrollment_key_origin !== 'generated' && row.enrollment_key_origin !== 'preexisting')
    || (row.maintenance_state !== 'active' && row.maintenance_state !== 'draining' && row.maintenance_state !== 'quiescent')
    || (row.session_security_state !== 'pending' && row.session_security_state !== 'cleaning' && row.session_security_state !== 'ready')
  ) {
    throw new PlatformInstanceStoreError('platform_instance 行包含非法枚举值。');
  }
  return row as PlatformInstanceRow;
}
