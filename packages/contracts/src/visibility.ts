import { z } from 'zod';

/**
 * 结果可见性：任何产出内容都只按该枚举投影。
 * 独立成模块避免 turn/world/combat/archive/ai 之间的循环 import。
 */
export const visibilitySchema = z.enum(['public', 'player_private', 'owner_only']);

export type Visibility = z.infer<typeof visibilitySchema>;
