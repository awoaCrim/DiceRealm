import { describe, expect, it } from 'vitest';
import type { AiProviderEnvConfig } from '../../config.js';
import { OpenAiCompatibleAiProvider } from './OpenAiCompatibleAiProvider.js';
import { UnavailableAiProvider } from './UnavailableAiProvider.js';
import { createAiProviderFromConfig, createConfiguredAiProvider } from './createAiProvider.js';

const valid: AiProviderEnvConfig = {
  provider: 'openai-compatible',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'sk-test',
  model: 'gpt-4o-mini',
  timeoutMs: 240000,
  temperature: 0.7,
};

describe('createAiProviderFromConfig', () => {
  it('builds the real adapter for a complete valid openai-compatible config', () => {
    const provider = createAiProviderFromConfig(valid);
    expect(provider).toBeInstanceOf(OpenAiCompatibleAiProvider);
    expect(provider.name).toBe('openai-compatible');
    expect(provider.model).toBe('gpt-4o-mini');
  });

  it('never produces a Mock: incomplete or blank openai-compatible configs fall back to UnavailableAiProvider', () => {
    for (const patch of [{ apiKey: '' }, { apiKey: '   ' }, { model: '' }, { baseUrl: '' }]) {
      const provider = createAiProviderFromConfig({ ...valid, ...patch });
      expect(provider).toBeInstanceOf(UnavailableAiProvider);
      expect(provider.name).not.toBe('mock');
    }
  });

  it('rejects non-http(s) or invalid base URLs with UnavailableAiProvider', () => {
    for (const baseUrl of ['ftp://example.test/v1', 'not-a-url']) {
      const provider = createAiProviderFromConfig({ ...valid, baseUrl });
      expect(provider).toBeInstanceOf(UnavailableAiProvider);
    }
  });

  it('falls back to UnavailableAiProvider for mock/scripted/unavailable providers', () => {
    for (const provider of ['mock', 'scripted', 'unavailable'] as const) {
      const providerInstance = createAiProviderFromConfig({ ...valid, provider } as AiProviderEnvConfig);
      expect(providerInstance).toBeInstanceOf(UnavailableAiProvider);
    }
  });
});

describe('createConfiguredAiProvider', () => {
  it('uses env to build the real adapter when fully configured', () => {
    const provider = createConfiguredAiProvider({
      AI_PROVIDER: 'openai-compatible',
      AI_PROVIDER_BASE_URL: 'https://api.openai.com/v1',
      AI_PROVIDER_API_KEY: 'sk-test',
      AI_PROVIDER_MODEL: 'gpt-4o-mini',
    });
    expect(provider.name).toBe('openai-compatible');
    expect(provider.model).toBe('gpt-4o-mini');
  });

  it('stays unavailable when AI_PROVIDER is unset or mock', () => {
    expect(createConfiguredAiProvider({}).name).toBe('unavailable');
    expect(createConfiguredAiProvider({ AI_PROVIDER: 'mock' }).name).toBe('unavailable');
  });

  it('stays unavailable when openai-compatible is incomplete', () => {
    expect(createConfiguredAiProvider({ AI_PROVIDER: 'openai-compatible', AI_PROVIDER_MODEL: 'm' }).name).toBe('unavailable');
    expect(createConfiguredAiProvider({
      AI_PROVIDER: 'openai-compatible',
      AI_PROVIDER_API_KEY: 'k',
      AI_PROVIDER_MODEL: 'm',
    }).name).toBe('unavailable');
  });
});
