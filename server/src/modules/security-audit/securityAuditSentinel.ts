import { AuditMetadataError } from './SecurityAuditEvent.js';

/**
 * 递归 secret sentinel：字段名或字符串值命中敏感语义时拒绝。
 *
 * 敏感 pattern 与决策一致：password|token|csrf|invite|authorization|api[_-]?key|
 * cipher|context|result|snapshot|story|body。
 *
 * 粗粒度 allowlist（coarse boolean/count/id/enum 字段）放行——例如 `sessionId`、
 * `inviteId`、`userId`、`count`、`ok`、`state`、`epoch`、`reason`、`exists`、
 * `verified`、`createdAt`。测试同时包含负面 secret 嵌套样本与每个 event schema
 * 的正面 coarse metadata 样本，防止 sentinel 把合法 outcome/count/id enum 锁死。
 */

const SENSITIVE_FIELD_PATTERN =
  /password|token|csrf|invite|authorization|api[_-]?key|cipher|context|result|snapshot|story|body/i;

/** coarse id/count/enum 字段名（大小写不敏感；`*Id` 后缀视为粗粒度 id）。 */
const COARSE_FIELD_PATTERN =
  /^(id|[a-z0-9]*id|count|total|ok|state|epoch|reason|exists|verified|created|createdat|expiresat|at|type|role|backupverified|accountid|userid|sessionid|inviteid|campaignid)$/i;

/** 非 coarse 字段下的字符串值若包含 secret 语义（高熵值兜底），一律拒绝。 */
const SECRET_VALUE_PATTERN = /password|secret|bearer|api[_-]?key|csrf/i;

function isCoarseField(key: string): boolean {
  return COARSE_FIELD_PATTERN.test(key);
}

function assertSafeString(key: string, value: string): void {
  if (!isCoarseField(key) && SECRET_VALUE_PATTERN.test(value)) {
    throw new AuditMetadataError('安全审计 metadata 包含敏感值，拒绝写入。');
  }
}

function walk(value: unknown, path: string): void {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      walk(value[i], `${path}[${i}]`);
    }
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      const fullPath = path ? `${path}.${key}` : key;
      if (SENSITIVE_FIELD_PATTERN.test(key) && !isCoarseField(key)) {
        throw new AuditMetadataError('安全审计 metadata 包含敏感字段名，拒绝写入。');
      }
      if (typeof child === 'string') {
        assertSafeString(key, child);
      } else {
        walk(child, fullPath);
      }
    }
    return;
  }
  if (typeof value === 'string') {
    // 顶层裸字符串（非对象字段）不允许出现在 metadata（strict schema 已限制）。
    assertSafeString('', value);
  }
}

/** 递归验证 metadata；任何命中立即抛 AuditMetadataError（绝不 stringify raw payload）。 */
export function assertAuditMetadataSafe(metadata: unknown): void {
  walk(metadata, '');
}
