import { z } from 'zod';

/**
 * SecurityAuditEvent：discriminated union。每种 metadata 独立 `.strict()`、bounded；
 * writer 不接受任意 object/request/headers/exception/URL/SQL params/upstream payload。
 */

export const auditOutcomeSchema = z.enum(['success', 'failure', 'rejected']);
export type AuditOutcome = z.infer<typeof auditOutcomeSchema>;

const idString = z.string().min(1).max(128);
const countField = z.number().int().min(0).max(1_000_000);
const reasonField = z.string().min(1).max(64);

export const auditMetadataSchemas = {
  'bootstrap.completed': z.object({ accountId: idString }).strict(),
  'bootstrap.rejected': z.object({ reason: reasonField }).strict(),
  'invite.created': z.object({ inviteId: idString }).strict(),
  'invite.revoked': z.object({ inviteId: idString }).strict(),
  'invite.consumed': z.object({ inviteId: idString, userId: idString }).strict(),
  'invite.rejected': z.object({ reason: reasonField }).strict(),
  'account.created': z.object({ userId: idString }).strict(),
  'account.disabled': z.object({ userId: idString }).strict(),
  'account.enabled': z.object({ userId: idString }).strict(),
  'admin.protection_rejected': z.object({ reason: reasonField }).strict(),
  'password.recovered': z.object({ userId: idString }).strict(),
  'session.created': z.object({ sessionId: idString }).strict(),
  'session.logout': z.object({ sessionId: idString }).strict(),
  'session.logout_all': z.object({ userId: idString, count: countField }).strict(),
  'session.admin_revoked': z.object({ userId: idString, count: countField }).strict(),
  'session.expired': z.object({ sessionId: idString }).strict(),
  'provider.saved': z.object({ campaignId: idString }).strict(),
  'provider.test': z.object({ ok: z.boolean() }).strict(),
  'maintenance.entered': z.object({ state: z.enum(['draining', 'quiescent']), epoch: z.number().int().min(0) }).strict(),
  'maintenance.exited': z.object({ epoch: z.number().int().min(0) }).strict(),
  'security.cutover': z.object({ backupVerified: z.boolean() }).strict(),
} as const;

export type AuditEventType = keyof typeof auditMetadataSchemas;
export type AuditMetadataMap = { [K in AuditEventType]: z.infer<(typeof auditMetadataSchemas)[K]> };

export interface SecurityAuditEvent<K extends AuditEventType = AuditEventType> {
  type: K;
  outcome: AuditOutcome;
  metadata: AuditMetadataMap[K];
}

const auditEventUnion = z.discriminatedUnion('type', Object.entries(auditMetadataSchemas).map(([type, schema]) =>
  z.object({ type: z.literal(type), outcome: auditOutcomeSchema, metadata: schema }).strict(),
) as never);

/** 严格解析事件（类型 + outcome + strict metadata）；失败抛带原因的审计错误（不输出 payload）。 */
export function parseAuditEvent(input: unknown): SecurityAuditEvent {
  const parsed = auditEventUnion.safeParse(input);
  if (!parsed.success) {
    throw new AuditMetadataError('安全审计事件 schema 校验失败。');
  }
  return parsed.data as SecurityAuditEvent;
}

/** 稳定、coarse、不携带 payload 的审计错误。 */
export class AuditMetadataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuditMetadataError';
  }
}
