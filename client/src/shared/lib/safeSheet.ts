/** 从角色 sheet（Record<string, unknown>）安全读取已知字段：类型不符/缺失时回退，绝不透传恶意对象。 */

export function readSheetString(
  sheet: Record<string, unknown> | null | undefined,
  key: string,
): string {
  const value = sheet?.[key];
  return typeof value === 'string' ? value : '';
}

export function readSheetNumber(
  sheet: Record<string, unknown> | null | undefined,
  key: string,
  fallback = 0,
): number {
  const value = sheet?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function readSheetBoolean(
  sheet: Record<string, unknown> | null | undefined,
  key: string,
): boolean {
  const value = sheet?.[key];
  return typeof value === 'boolean' ? value : false;
}

export function readSheetStringArray(
  sheet: Record<string, unknown> | null | undefined,
  key: string,
): string[] {
  const value = sheet?.[key];
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === 'string');
}

/** 安全读取对象字段；类型不符/缺失返回 null。用于 derived 等嵌套结构。 */
export function readSheetObject(
  sheet: Record<string, unknown> | null | undefined,
  key: string,
): Record<string, unknown> | null {
  const value = sheet?.[key];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

/** 安全读取字符串记录：只保留 string 值。 */
export function readSheetStringRecord(
  sheet: Record<string, unknown> | null | undefined,
  key: string,
): Record<string, string> {
  const value = sheet?.[key];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'string') {
      out[k] = v;
    }
  }
  return out;
}
