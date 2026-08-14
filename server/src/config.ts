import 'dotenv/config';
import { isIP } from 'node:net';
import proxyaddr from 'proxy-addr';

export interface SecurityConfig {
  publicOrigin: string;
  deploymentMode: 'production' | 'development' | 'test';
  trustedProxyCidrs: readonly string[];
  devAllowedOrigins: readonly string[];
  allowedOrigins: readonly string[];
}

export interface AppConfig {
  host: string;
  port: number;
  databasePath: string;
  security?: SecurityConfig;
}

const ORIGIN_RE = /^(https):\/\/([^/:?#]+|\[[0-9a-fA-F:.]+\])(?::([0-9]+))?$/;

function canonicalOrigin(value: string, name: string, requireHttps = false): string {
  if (!value || value !== value.trim() || value.includes('*')) throw new Error(`${name} must be an explicit origin`);
  const match = /^(https?):\/\/([^/:?#]+|\[[0-9a-fA-F:.]+\])(?::([0-9]+))?$/.exec(value);
  if (!match || (requireHttps && match[1] !== 'https')) throw new Error(`${name} must be canonical ${requireHttps ? 'HTTPS ' : ''}origin`);
  const url = new URL(value);
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error(`${name} must not contain credentials, path, query, or hash`);
  const host = url.hostname.toLowerCase();
  const parsedPort = match[3] ? Number(match[3]) : undefined;
  if (parsedPort !== undefined && (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535)) throw new Error(`${name} has an invalid port`);
  const port = parsedPort !== undefined && !((match[1] === 'https' && parsedPort === 443) || (match[1] === 'http' && parsedPort === 80)) ? `:${parsedPort}` : '';
  return `${match[1]}://${host}${port}`;
}

function parseCidrs(value: string | undefined): string[] {
  if (!value || !value.trim()) return [];
  const values = value.split(',').map((part) => part.trim());
  if (values.some((part) => !part || part === '*' || part.includes('true'))) throw new Error('TRUSTED_PROXY_CIDRS must contain exact IP/CIDR values');
  try {
    // compile validates both address family and CIDR syntax. Keep original canonical strings for diagnostics/config.
    proxyaddr.compile(values);
    for (const value of values) {
      const [address, prefix] = value.split('/');
      if (!isIP(address) || (prefix !== undefined && (!/^\d+$/.test(prefix) || Number(prefix) > (isIP(address) === 4 ? 32 : 128)))) throw new Error('invalid trusted proxy CIDR');
    }
    return values;
  } catch { throw new Error('TRUSTED_PROXY_CIDRS contains an invalid IP/CIDR'); }
}

export function parseSecurityConfig(env: Record<string, string | undefined>): SecurityConfig {
  const deploymentMode = env.NODE_ENV === 'production' ? 'production' : env.NODE_ENV === 'test' ? 'test' : 'development';
  const publicOrigin = canonicalOrigin(env.PUBLIC_ORIGIN ?? '', 'PUBLIC_ORIGIN', true);
  const trustedProxyCidrs = parseCidrs(env.TRUSTED_PROXY_CIDRS);
  const devAllowedOrigins = (env.DEV_ALLOWED_ORIGINS ?? '').trim() === '' ? [] : env.DEV_ALLOWED_ORIGINS!.split(',').map((value) => canonicalOrigin(value.trim(), 'DEV_ALLOWED_ORIGINS'));
  if (deploymentMode === 'production' && devAllowedOrigins.length > 0) throw new Error('DEV_ALLOWED_ORIGINS is not allowed in production');
  const allowedOrigins = [publicOrigin, ...(deploymentMode === 'production' ? [] : devAllowedOrigins)];
  if (env.BOOTSTRAP_ENABLED !== undefined || env.BOOTSTRAP_DATABASE_ID !== undefined || env.BOOTSTRAP_SECRET !== undefined) {
    const databaseId = env.BOOTSTRAP_DATABASE_ID;
    const secret = env.BOOTSTRAP_SECRET;
    if (env.BOOTSTRAP_ENABLED !== 'true' || !databaseId || databaseId !== databaseId.trim() || databaseId.length > 256 || /[\u0000-\u001f\u007f]/.test(databaseId) || !secret || !/^[A-Za-z0-9_-]{43}$/.test(secret)) throw new Error('invalid bootstrap configuration');
    const decoded = Buffer.from(secret, 'base64url');
    if (decoded.length !== 32 || decoded.toString('base64url') !== secret) throw new Error('invalid bootstrap secret');
  }
  return { publicOrigin, deploymentMode, trustedProxyCidrs, devAllowedOrigins, allowedOrigins };
}

export function loadConfig(): AppConfig {
  return {
    host: process.env.HOST ?? '0.0.0.0',
    port: Number(process.env.PORT ?? 3000),
    databasePath: process.env.DATABASE_PATH ?? 'dnd.sqlite',
    security: parseSecurityConfig(process.env),
  };
}

/** 环境变量解析出的 AI Provider 配置（仅服务端进程环境/内存持有；apiKey 不落库、不进日志/DTO）。 */
export interface AiProviderEnvConfig {
  provider: 'openai-compatible' | 'unavailable';
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  temperature: number;
}

export const DEFAULT_AI_PROVIDER_TIMEOUT_MS = 240_000;
export const DEFAULT_AI_PROVIDER_TEMPERATURE = 0.7;

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function boundedTemperature(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 2 ? parsed : fallback;
}

export function parseAiProviderEnv(env: Record<string, string | undefined>): AiProviderEnvConfig {
  if (env.AI_PROVIDER !== 'openai-compatible') {
    return { provider: 'unavailable', baseUrl: '', apiKey: '', model: '', timeoutMs: DEFAULT_AI_PROVIDER_TIMEOUT_MS, temperature: DEFAULT_AI_PROVIDER_TEMPERATURE };
  }
  return {
    provider: 'openai-compatible', baseUrl: (env.AI_PROVIDER_BASE_URL ?? '').trim(), apiKey: env.AI_PROVIDER_API_KEY ?? '', model: (env.AI_PROVIDER_MODEL ?? '').trim(),
    timeoutMs: positiveInteger(env.AI_PROVIDER_TIMEOUT_MS, DEFAULT_AI_PROVIDER_TIMEOUT_MS), temperature: boundedTemperature(env.AI_PROVIDER_TEMPERATURE, DEFAULT_AI_PROVIDER_TEMPERATURE),
  };
}
