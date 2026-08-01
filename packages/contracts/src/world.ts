import { z } from 'zod';
import { visibilitySchema } from './turn.js';

/** 世界事实 contract：owner 写入，player 只读经 VisibilityPolicy 投影。 */

export const worldFactKindSchema = z.enum([
  'location', 'npc', 'item', 'lore', 'faction', 'quest', 'custom',
]);

export type WorldFactKind = z.infer<typeof worldFactKindSchema>;

/** owner 创建/更新世界事实的输入。knownBy 语义：public/owner_only 必须为空（service 强制落库 []）；
 *  player_private 必须给出非空的目标 playerId 列表，每个都必须是该 campaign 的 player 成员。
 *  用 z.input 使 knownBy 在输入侧可选（缺省时 parse 落库 []）。 */
export const worldFactInputSchema = z.object({
  title: z.string().trim().min(1),
  kind: worldFactKindSchema,
  content: z.string().min(1),
  visibility: visibilitySchema,
  knownBy: z.array(z.string().min(1)).default([]),
});

export type WorldFactInput = z.input<typeof worldFactInputSchema>;

/** 事实 DTO。knownBy 已按观看者投影：owner 可见完整列表；player 只见 []（public）或 [自己的 playerId]。 */
export const worldFactSchema = z.object({
  id: z.string().min(1),
  campaignId: z.string().min(1),
  title: z.string().min(1),
  kind: worldFactKindSchema,
  content: z.string(),
  visibility: visibilitySchema,
  knownBy: z.array(z.string()),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type WorldFact = z.infer<typeof worldFactSchema>;

export const worldFactProjectionSchema = z.object({
  facts: z.array(worldFactSchema),
});

export type WorldFactProjection = z.infer<typeof worldFactProjectionSchema>;
