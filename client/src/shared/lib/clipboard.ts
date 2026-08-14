/** 复制文本到剪贴板：不可用/拒绝 → 'manual'（由页面提示手动复制）；成功 → 'copied'。 */
export async function copyTextToClipboard(text: string): Promise<'copied' | 'manual'> {
  try {
    const clipboard =
      typeof navigator !== 'undefined' && typeof navigator.clipboard !== 'undefined'
        ? navigator.clipboard
        : undefined;
    if (!clipboard || typeof clipboard.writeText !== 'function') {
      return 'manual';
    }
    await clipboard.writeText(text);
    return 'copied';
  } catch {
    return 'manual';
  }
}
