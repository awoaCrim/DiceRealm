import type { Request, RequestHandler } from 'express';
import { isIP } from 'node:net';
import proxyaddr from 'proxy-addr';
import type { SecurityConfig } from '../../config.js';
import { AppError } from './AppError.js';

export interface EffectiveRequestSecurity { isHttps: boolean; host: string; clientIp: string; origin: string | null; }
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const HOST_RE = /^(?:[^/:?#]+|\[[0-9a-fA-F:.]+\])(?::\d+)?$/;
function oneForwarded(value: string | undefined, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (value.includes(',')) throw new Error(`ambiguous ${name}`);
  const trimmed = value.trim();
  if (!trimmed || /[\r\n]/.test(trimmed)) throw new Error(`malformed ${name}`);
  return trimmed;
}
function normalizeHost(value: string, scheme?: string): string {
  if (!HOST_RE.test(value) || /[\s@]/.test(value)) throw new Error('malformed host');
  const bracketed = value.startsWith('[');
  const split = bracketed ? value.lastIndexOf(']') : value.lastIndexOf(':');
  const host = (bracketed ? value.slice(0, split + 1) : split > 0 ? value.slice(0, split) : value).toLowerCase();
  const rawPort = bracketed ? value.slice(split + 1) : split > 0 ? value.slice(split + 1) : '';
  const port = rawPort ? Number(rawPort) : undefined;
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) throw new Error('malformed host port');
  const defaultPort = scheme === 'https' ? 443 : scheme === 'http' ? 80 : undefined;
  return `${host}${port !== undefined && port !== defaultPort ? `:${port}` : ''}`;
}
function normalizeOrigin(value: string): string {
  if (value === 'null') return value;
  const url = new URL(value);
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('malformed origin');
  return `${url.protocol}//${normalizeHost(url.host, url.protocol.slice(0, -1))}`;
}
function originHost(origin: string): string { const url = new URL(origin); return normalizeHost(url.host, url.protocol.slice(0, -1)); }
function readHeader(req: Request, name: string): string | undefined {
  const value = req.headers[name.toLowerCase()];
  return Array.isArray(value) ? value.join(',') : value;
}
function hasHeader(req: Request, name: string): boolean { return Object.prototype.hasOwnProperty.call(req.headers, name.toLowerCase()); }

export class RequestSecurityPolicy {
  readonly config: SecurityConfig;
  private readonly trustProxy: (ip: string) => boolean;
  constructor(config: SecurityConfig) {
    this.config = config;
    this.trustProxy = config.trustedProxyCidrs.length ? proxyaddr.compile([...config.trustedProxyCidrs]) as (ip: string) => boolean : () => false;
  }
  isTrustedProxy(ip: string | undefined): boolean { return typeof ip === 'string' && this.trustProxy(ip); }
  resolve(req: Request): EffectiveRequestSecurity {
    const directIp = req.socket.remoteAddress ?? '';
    const trusted = this.isTrustedProxy(directIp);
    const directHttps = (req.socket as { encrypted?: boolean }).encrypted === true;
    const xfp = trusted ? oneForwarded(readHeader(req, 'x-forwarded-proto'), 'X-Forwarded-Proto') : undefined;
    const xhost = trusted ? oneForwarded(readHeader(req, 'x-forwarded-host'), 'X-Forwarded-Host') : undefined;
    const xfor = trusted ? oneForwarded(readHeader(req, 'x-forwarded-for'), 'X-Forwarded-For') : undefined;
    const proto = xfp ?? (directHttps ? 'https' : 'http');
    if (!/^[a-z][a-z0-9+.-]*$/i.test(proto) || (proto !== 'https' && proto !== 'http')) throw new Error('malformed forwarded protocol');
    const host = normalizeHost(xhost ?? req.headers.host ?? '', proto);
    const clientIp = xfor ?? directIp;
    if (!clientIp || /[\s,;]/.test(clientIp) || isIP(clientIp) === 0) throw new Error('malformed forwarded client IP');
    if (trusted && hasHeader(req, 'forwarded')) throw new Error('unsupported Forwarded header');
    const value = readHeader(req, 'origin');
    return { isHttps: proto === 'https', host, clientIp, origin: value === undefined ? null : normalizeOrigin(value) };
  }
  middleware(): RequestHandler {
    return (req, res, next) => {
      // Direct TLS is already authoritative enough to retain HSTS on later policy rejection;
      // a trusted forwarded http result below explicitly removes it.
      if ((req.socket as { encrypted?: boolean }).encrypted === true) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
      try {
        const security = this.resolve(req);
        (req as unknown as { security?: EffectiveRequestSecurity }).security = security;
        if (security.isHttps) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
        else res.removeHeader('Strict-Transport-Security');
        const origin = security.origin;
        const allowedOrigin = origin && origin !== 'null' && this.config.allowedOrigins.includes(origin) ? origin : null;
        if (!security.isHttps) throw new AppError('FORBIDDEN', '请求必须使用 HTTPS。');
        if (security.host !== originHost(this.config.publicOrigin)) throw new AppError('FORBIDDEN', '请求 Host 不受支持。');
        if (!SAFE_METHODS.has(req.method) && !allowedOrigin) throw new AppError('FORBIDDEN', '请求来源不受支持。');
        if (req.method === 'OPTIONS' && !allowedOrigin) throw new AppError('FORBIDDEN', '请求来源不受支持。');
        if (allowedOrigin) {
          res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
          res.setHeader('Access-Control-Allow-Credentials', 'true');
        }
        if (req.method === 'OPTIONS') {
          res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS');
          res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-CSRF-Token');
          res.status(204).end();
          return;
        }
        next();
      } catch (error) { next(error instanceof AppError ? error : new AppError('FORBIDDEN', '请求安全策略拒绝该请求。')); }
    };
  }
  trustProxyPredicate(): (ip: string) => boolean { return this.trustProxy; }
}
export function getRequestSecurity(req: Request): EffectiveRequestSecurity | undefined { return (req as unknown as { security?: EffectiveRequestSecurity }).security; }
