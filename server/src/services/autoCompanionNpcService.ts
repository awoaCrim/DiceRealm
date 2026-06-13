import { nanoid } from 'nanoid';
import type { AppDatabase } from '../db/connection.js';

const TARGET_PARTY_SIZE = 4;
const AUTO_COMPANION_MARKER = '[AUTO_COMPANION_NPC]';

const companionTemplates = [
  {
    name: '希拉',
    role: '补位同伴：治疗与支援',
    attitude: 'friendly',
    notes: `${AUTO_COMPANION_MARKER} 当真实玩家少于 4 人时自动加入的队伍同伴。希拉是谨慎的旅行医者，擅长照料伤员、辨认草药，并在队伍犹豫时提出稳妥建议。`,
    location: '随队行动'
  },
  {
    name: '布兰',
    role: '补位同伴：前排护卫',
    attitude: 'friendly',
    notes: `${AUTO_COMPANION_MARKER} 当真实玩家少于 4 人时自动加入的队伍同伴。布兰是沉默可靠的佣兵，习惯举盾护住后排，但不会替玩家决定路线或关键选择。`,
    location: '随队行动'
  },
  {
    name: '米瑞尔',
    role: '补位同伴：斥候与调查',
    attitude: 'friendly',
    notes: `${AUTO_COMPANION_MARKER} 当真实玩家少于 4 人时自动加入的队伍同伴。米瑞尔熟悉道路、锁具和可疑痕迹，常提供线索观察，但最终判断交给玩家。`,
    location: '随队行动'
  }
] as const;

export function requiredCompanionNpcCount(expectedPlayerCount: number): number {
  return Math.max(0, TARGET_PARTY_SIZE - expectedPlayerCount);
}

export function ensureAutoCompanionNpcs(db: AppDatabase, roomId: string, expectedPlayerCount: number): number {
  const required = requiredCompanionNpcCount(expectedPlayerCount);
  if (required <= 0) return 0;

  const existingRows = db.prepare(`
    SELECT name
    FROM campaign_npcs
    WHERE room_id = ? AND notes LIKE ?
    ORDER BY updated_at ASC
  `).all(roomId, `${AUTO_COMPANION_MARKER}%`) as Array<{ name: string }>;
  const existingNames = new Set(existingRows.map((row) => row.name));
  let created = 0;
  const now = new Date().toISOString();

  for (const template of companionTemplates) {
    if (existingNames.size >= required) break;
    if (existingNames.has(template.name)) continue;
    db.prepare(`
      INSERT INTO campaign_npcs (id, room_id, name, role, attitude, notes, location, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(nanoid(), roomId, template.name, template.role, template.attitude, template.notes, template.location, now);
    existingNames.add(template.name);
    created += 1;
  }

  return created;
}
