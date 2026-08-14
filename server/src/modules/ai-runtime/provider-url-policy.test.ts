import { describe, expect, it } from 'vitest';
import { assertSafeProviderUrl } from './ProviderUrlPolicy.js';

describe('assertSafeProviderUrl', () => {
  it.each([
    'https://newapi.uwoacrimson.com/v1',
    'http://127.0.0.1:3000/v1',
    'http://10.0.0.1/v1',
    'http://192.168.1.20:11434/v1',
    'http://198.18.0.67/v1',
    'http://[::1]/v1',
    'http://[fc00::1]/v1',
  ])('allows any valid HTTP(S) destination %s without DNS/IP classification', async (url) => {
    await expect(assertSafeProviderUrl(url)).resolves.toMatchObject({
      protocol: expect.stringMatching(/^https?:$/),
    });
  });

  it('does not require DNS resolution before accepting a hostname', async () => {
    await expect(assertSafeProviderUrl('https://definitely-does-not-exist.invalid/v1')).resolves.toMatchObject({
      hostname: 'definitely-does-not-exist.invalid',
    });
  });

  it.each([
    'not a url',
    'file:///etc/passwd',
    'https://user:pass@example.com/v1',
  ])('rejects malformed, non-http(s), or credential-bearing URL %s', async (url) => {
    await expect(assertSafeProviderUrl(url)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });
});
