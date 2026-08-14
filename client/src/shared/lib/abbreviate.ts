/** 统一缩写 ID：例如前 6 + 后 4。不声称它是玩家姓名。 */
export function abbreviateId(id: string): string {
  if (id.length <= 10) {
    return id;
  }
  return `${id.slice(0, 6)}…${id.slice(-4)}`;
}
