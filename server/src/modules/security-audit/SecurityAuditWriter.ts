import { randomUUID } from 'node:crypto';
import type { QueryExecutor } from '../../platform/database/DatabasePort.js';
import { parseAuditEvent, type SecurityAuditEvent } from './SecurityAuditEvent.js';
import { assertAuditMetadataSafe } from './securityAuditSentinel.js';

export interface AuditActor {
  /** 可选 actor 用户 id（管理员/本人）。 */
  actorUserId?: string | null;
  /** 可选 target 用户 id。 */
  subjectUserId?: string | null;
}

/**
 * typed 安全审计 writer。只提供 `writeIn(tx, event)` 追加写入；
 * 没有任何 update/delete mutation method（DB trigger 同样强制 append-only）。
 *
 * metadata 必须先通过 strict per-event schema 与递归 secret sentinel；
 * 任何失败抛 AuditMetadataError，绝不 stringify raw payload / headers / exception。
 */
export class SecurityAuditWriter {
  async writeIn(tx: QueryExecutor, event: SecurityAuditEvent, actor?: AuditActor): Promise<void> {
    // 防御性二次校验（类型层面已保证；防止未来绕过）。
    const parsed = parseAuditEvent(event);
    assertAuditMetadataSafe(parsed.metadata);

    const id = randomUUID();
    const now = new Date().toISOString();
    await tx.execute(
      `INSERT INTO platform_security_audit_events
         (id, event_type, outcome, actor_user_id, subject_user_id, metadata_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        parsed.type,
        parsed.outcome,
        actor?.actorUserId ?? null,
        actor?.subjectUserId ?? null,
        JSON.stringify(parsed.metadata),
        now,
      ],
    );
  }
}
