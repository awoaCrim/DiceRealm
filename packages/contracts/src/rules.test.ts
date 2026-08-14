import { describe, expect, it } from 'vitest';
import {
  appErrorCodes,
  ruleSourceRegistrationInputSchema,
  ruleSourceSchema,
} from './index.js';

const hash = 'ab'.repeat(32);

describe('rule source contracts', () => {
  it('accepts metadata-only campaign and user registrations', () => {
    expect(ruleSourceRegistrationInputSchema.parse({
      sourceName: 'Open Reference',
      version: '2024.1',
      license: 'CC-BY-4.0',
      attribution: 'Example Author',
      contentHash: hash,
      scope: 'campaign',
    })).toMatchObject({ scope: 'campaign', contentHash: hash });

    expect(ruleSourceRegistrationInputSchema.parse({
      sourceName: 'My Homebrew',
      version: '1',
      license: 'User-owned private content',
      attribution: 'alice',
      contentHash: hash,
      scope: 'user',
    })).toMatchObject({ scope: 'user' });
  });

  it('rejects rule bodies at both the registration and response seams', () => {
    expect(() => ruleSourceRegistrationInputSchema.parse({
      sourceName: 'No body',
      version: '1',
      license: 'CC0-1.0',
      attribution: 'Example',
      contentHash: hash,
      scope: 'campaign',
      content: 'third-party rule text must never cross this seam',
    })).toThrow();

    expect(() => ruleSourceSchema.parse({
      id: 'rs-1',
      sourceName: 'No body',
      version: '1',
      license: 'CC0-1.0',
      attribution: 'Example',
      contentHash: hash,
      scope: 'campaign',
      campaignId: 'campaign-1',
      createdAt: '2026-08-10T00:00:00.000Z',
      content: 'third-party rule text must never cross this seam',
    })).toThrow();
  });

  it('includes INVALID_RULE_SOURCE in the shared error-code contract', () => {
    expect(appErrorCodes).toContain('INVALID_RULE_SOURCE');
  });
});
