import type { CampaignNpc, CampaignQuest, RoomStatus, TurnStatus } from './types';

export function roomStatusLabel(status: RoomStatus | TurnStatus | string | null | undefined): string {
  switch (status) {
    case 'setup': return '准备中';
    case 'waiting_for_actions': return '等待玩家行动';
    case 'open': return '等待玩家行动';
    case 'ready_to_resolve': return '等待主持人结算';
    case 'waiting_for_interaction': return '等待玩家回应互动';
    case 'processing':
    case 'resolving': return '正在结算';
    case 'locked': return '已锁定';
    case 'complete':
    case 'completed':
    case 'resolved': return '已完成';
    case 'needs_admin_attention': return '需要主持人处理';
    default: return status || '未知状态';
  }
}

export function questStatusLabel(status: CampaignQuest['status'] | string | undefined): string {
  switch (status) {
    case 'active': return '待推进';
    case 'in_progress': return '进行中';
    case 'completed': return '已完成';
    case 'failed': return '失败';
    default: return status || '未知状态';
  }
}

export function npcAttitudeLabel(attitude: CampaignNpc['attitude'] | string | undefined): string {
  switch (attitude) {
    case 'friendly': return '友好';
    case 'neutral': return '中立';
    case 'hostile': return '敌对';
    case 'unknown': return '未知';
    default: return attitude || '未知';
  }
}

export function actorTypeLabel(actorType: string | undefined): string {
  switch (actorType) {
    case 'player': return '玩家';
    case 'admin': return '主持人';
    case 'ai': return 'AI';
    case 'system': return '系统';
    default: return actorType || '未知来源';
  }
}

export function dbSourceTypeLabel(sourceType: string | undefined): string {
  switch (sourceType) {
    case 'table_plugin': return '表格数据库插件';
    case 'world_book': return '世界书';
    case 'preset_package': return '预设包';
    case 'character_options': return '角色选项库';
    case 'rules_json': return '规则库';
    case 'sillytavern_character': return 'ST 角色卡';
    case 'sillytavern_world_book': return 'ST 世界书';
    default: return sourceType || '未知来源';
  }
}

export function promptModeLabel(mode: string | undefined): string {
  switch (mode) {
    case 'native': return '原生预设';
    case 'sillytavern-compatible': return 'SillyTavern 兼容预设';
    default: return mode || '未知模式';
  }
}

export function promptRoleLabel(role: string | undefined): string {
  switch (role) {
    case 'system': return '系统';
    case 'user': return '用户';
    case 'assistant': return '助手';
    default: return role || '未知角色';
  }
}

export function promptBlockPositionLabel(position: string | undefined): string {
  switch (position) {
    case 'before_world': return '世界信息前';
    case 'after_world': return '世界信息后';
    case 'before_actions': return '行动前';
    case 'after_actions': return '行动后';
    case 'final': return '最终输出前';
    default: return position || '未知位置';
  }
}

export function presetTypeLabel(type: string | null | undefined): string {
  switch (type) {
    case 'tutorial': return '新手教程';
    case 'rules_strict': return '规则参考';
    case 'story_first': return '剧情优先';
    case 'combat_first': return '战斗优先';
    case 'casual': return '轻松跑团';
    case 'dark_fantasy': return '黑暗奇幻';
    case 'sandbox': return '沙盒探索';
    case 'epic': return '史诗冒险';
    default: return type || '未分类';
  }
}

export function sceneTypeLabel(type: string | null | undefined): string {
  switch (type) {
    case 'exploration': return '探索';
    case 'social': return '社交';
    case 'combat': return '战斗';
    case 'all': return '通用';
    default: return type || '通用';
  }
}

export function moduleCategoryLabel(category: string | null | undefined): string {
  switch (category) {
    case 'core_identity': return '核心身份';
    case 'player_boundary': return '玩家边界';
    case 'npc_autonomy': return 'NPC 自主性';
    case 'anti_omniscience': return '防全知';
    case 'style': return '风格';
    case 'perspective': return '视角';
    case 'pacing': return '节奏';
    case 'rules_judgment': return '规则裁定';
    case 'status_update': return '状态更新';
    case 'summary': return '摘要';
    case 'worldbook_injection': return '世界书注入';
    default: return category || '';
  }
}

export function promptSourceLabel(source: string | undefined): string {
  switch (source) {
    case 'st-preset': return 'ST 预设';
    case 'runtime-slot': return '运行时槽位';
    case 'dnd-contract': return 'DND 输出契约';
    case 'native-preset': return '原生预设';
    case 'script-card': return '剧本卡';
    case 'world-book': return '世界书';
    default: return source || '未知来源';
  }
}

export function worldBookMatchReasonLabel(reason: string | undefined): string {
  switch (reason) {
    case 'constant': return '常驻注入';
    case 'primary-key': return '主关键词命中';
    case 'primary-and-secondary-key': return '主次关键词命中';
    default: return reason || '未知命中原因';
  }
}

export function worldBookPositionLabel(position: string | undefined): string {
  switch (position) {
    case 'before': return '世界信息前';
    case 'after': return '世界信息后';
    default: return position || '未知位置';
  }
}

export function ruleReasonLabel(reason: string | undefined): string {
  switch (reason) {
    case 'keyword': return '关键词';
    case 'semantic': return '语义';
    default: return reason || '未知';
  }
}

export function ruleCategoryLabel(category: string | undefined): string {
  switch (category) {
    case 'combat': return '战斗';
    case 'exploration': return '探索';
    case 'social': return '社交';
    case 'all': return '通用';
    default: return category || '未分类';
  }
}

export function formatFileSize(bytes: number | null | undefined): string {
  if (!Number.isFinite(bytes ?? NaN) || (bytes ?? 0) < 0) return '未知大小';
  const value = bytes ?? 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KB`;
  return `${(value / 1024 / 1024).toFixed(value < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

export function formatIsoDateTime(value: string | null | undefined): string {
  if (!value) return '';
  const match = value.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);
  return match ? `${match[1]} ${match[2]}` : value;
}
