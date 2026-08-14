/**
 * 当前 Phase 批准的 migration 集合（literal frozen）。
 *
 * 普通 server 启动（StartupSecurityGate）与 fresh init（EnrollmentCoordinator）
 * 只接受/应用该精确集合 001-014；不得从 manifest 或迁移目录静默扩展。
 * 未来 Phase 的 015+ 必须在其详细计划中新增显式 hash-bound apply 命令/allowlist
 * （参照 SecurityCutoverCoordinator.SECURITY_CUTOVER_ALLOWLIST），
 * 否则 ordinary startup 拒绝、fresh init 不应用。
 */
export const PHASE2_APPROVED_MIGRATION_FILENAMES: readonly string[] = [
  '001_initial_platform.sql',
  '002_campaign_invites.sql',
  '003_characters.sql',
  '004_world_state.sql',
  '005_events_outbox.sql',
  '006_turns_actions.sql',
  '007_archives.sql',
  '008_ai_runtime.sql',
  '009_combat.sql',
  '010_ai_provider_credentials.sql',
  '011_rule_sources.sql',
  '012_platform_foundation.sql',
  '013_secure_sessions.sql',
  '014_security_audit.sql',
];
