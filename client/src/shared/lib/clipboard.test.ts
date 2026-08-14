import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyTextToClipboard } from './clipboard';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('copyTextToClipboard', () => {
  it('navigator.clipboard 不可用时返回 manual', async () => {
    vi.stubGlobal('navigator', {});
    await expect(copyTextToClipboard('x')).resolves.toBe('manual');
  });

  it('writeText 拒绝时返回 manual', async () => {
    vi.stubGlobal('navigator', {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
    });
    await expect(copyTextToClipboard('x')).resolves.toBe('manual');
  });

  it('writeText 成功时返回 copied', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    await expect(copyTextToClipboard('x')).resolves.toBe('copied');
    expect(writeText).toHaveBeenCalledWith('x');
  });
});
