/**
 * 当前维护的 migration 集合（literal frozen）。
 *
 * 普通 server 启动（StartupSecurityGate）与 fresh init（EnrollmentCoordinator）
 * 只接受/应用该精确集合；不得从 manifest 或迁移目录静默扩展。
 * The current application schema adds server adjudication as an explicit maintained set;
 * future migrations must add their own hash-bound apply command/allowlist (see
 * SecurityCutoverCoordinator.SECURITY_CUTOVER_ALLOWLIST) instead of being silently
 * accepted by ordinary startup or fresh init.
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
  '012_platform_foundation.sql',
  '013_secure_sessions.sql',
  '014_security_audit.sql',
  '015_campaign_state_revision.sql',
];

/** Current application schema: the maintained baseline plus server adjudication. */
export const PHASE3_APPROVED_MIGRATION_FILENAMES: readonly string[] = [
  ...PHASE2_APPROVED_MIGRATION_FILENAMES,
  '016_server_adjudication_dice.sql',
];
