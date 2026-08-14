import { AppError } from '../../platform/http/AppError.js';

/**
 * Validate only the Provider URL shape. Owner-configured loopback, LAN,
 * reserved and proxy fake-IP destinations are intentionally allowed.
 */
export async function assertSafeProviderUrl(rawUrl: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw invalidProviderUrl();
  }

  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:')
    || !url.hostname
    || url.username
    || url.password
  ) {
    throw invalidProviderUrl();
  }

  return url;
}

function invalidProviderUrl(): AppError {
  return new AppError('VALIDATION_ERROR', 'API 地址必须是有效的 HTTP(S) URL，且不能包含用户名或密码。');
}
