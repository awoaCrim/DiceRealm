import { describe, expect, it } from 'vitest';
import { parseAiProviderEnv } from '../config.js';

describe('parseAiProviderEnv', () => {
  it('parses a complete openai-compatible env config with runtime settings', () => {
    const cfg = parseAiProviderEnv({
      AI_PROVIDER: 'openai-compatible',
      AI_PROVIDER_BASE_URL: ' https://api.openai.com/v1 ',
      AI_PROVIDER_API_KEY: 'sk-test',
      AI_PROVIDER_MODEL: ' gpt-4o-mini ',
      AI_PROVIDER_TIMEOUT_MS: '120000',
      AI_PROVIDER_MAX_ATTEMPTS: '5',
      AI_PROVIDER_TEMPERATURE: '1.2',
    });
    expect(cfg).toEqual({
      provider: 'openai-compatible',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
      model: 'gpt-4o-mini',
      timeoutMs: 120000,
      temperature: 1.2,
    });
    // AI_PROVIDER_MAX_ATTEMPTS 不再是平台配置面：输出对象不含该字段。
    expect('maxAttempts' in cfg).toBe(false);
  });

  it('falls back to unavailable when AI_PROVIDER is absent', () => {
    expect(parseAiProviderEnv({})).toEqual({
      provider: 'unavailable',
      baseUrl: '',
      apiKey: '',
      model: '',
      timeoutMs: 240000,
      temperature: 0.7,
    });
  });

  it('falls back to unavailable for non-openai-compatible kinds', () => {
    for (const kind of ['mock', 'scripted', 'bogus', '']) {
      expect(parseAiProviderEnv({ AI_PROVIDER: kind }).provider).toBe('unavailable');
    }
  });

  it('keeps safe defaults for invalid or blank runtime numbers', () => {
    const cfg = parseAiProviderEnv({
      AI_PROVIDER: 'openai-compatible',
      AI_PROVIDER_BASE_URL: 'https://x.test/v1',
      AI_PROVIDER_API_KEY: 'k',
      AI_PROVIDER_MODEL: 'm',
      AI_PROVIDER_TIMEOUT_MS: 'abc',
      AI_PROVIDER_MAX_ATTEMPTS: '-2',
      AI_PROVIDER_TEMPERATURE: '',
    });
    expect(cfg.timeoutMs).toBe(240000);
    expect(cfg.temperature).toBe(0.7);
  });

  it('rejects non-positive integers and out-of-range temperature with defaults', () => {
    const cfg = parseAiProviderEnv({
      AI_PROVIDER: 'openai-compatible',
      AI_PROVIDER_BASE_URL: 'https://x.test/v1',
      AI_PROVIDER_API_KEY: 'k',
      AI_PROVIDER_MODEL: 'm',
      AI_PROVIDER_TIMEOUT_MS: '0',
      AI_PROVIDER_MAX_ATTEMPTS: '0',
      AI_PROVIDER_TEMPERATURE: '2.5',
    });
    expect(cfg.timeoutMs).toBe(240000);
    expect(cfg.temperature).toBe(0.7);
  });

  it('accepts a boundary temperature of 2', () => {
    const cfg = parseAiProviderEnv({
      AI_PROVIDER: 'openai-compatible',
      AI_PROVIDER_BASE_URL: 'https://x.test/v1',
      AI_PROVIDER_API_KEY: 'k',
      AI_PROVIDER_MODEL: 'm',
      AI_PROVIDER_TEMPERATURE: '2',
    });
    expect(cfg.temperature).toBe(2);
  });
});
