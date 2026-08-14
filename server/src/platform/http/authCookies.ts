import type { Response } from 'express';

export const SESSION_COOKIE_NAME = '__Host-dnd_session';
export const CSRF_COOKIE_NAME = '__Host-dnd_csrf';
export const SESSION_COOKIE_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

const BASE_OPTIONS = {
  secure: true,
  sameSite: 'lax' as const,
  path: '/',
  maxAge: SESSION_COOKIE_MAX_AGE_SECONDS * 1000,
};

export function setAuthCookies(res: Response, rawToken: string, rawCsrfToken: string): void {
  res.cookie(SESSION_COOKIE_NAME, rawToken, { ...BASE_OPTIONS, httpOnly: true });
  res.cookie(CSRF_COOKIE_NAME, rawCsrfToken, { ...BASE_OPTIONS, httpOnly: false });
}

export function setCsrfCookie(res: Response, rawCsrfToken: string): void {
  res.cookie(CSRF_COOKIE_NAME, rawCsrfToken, { ...BASE_OPTIONS, httpOnly: false });
}

export function clearAuthCookies(res: Response): void {
  res.clearCookie(SESSION_COOKIE_NAME, { secure: true, sameSite: 'lax', path: '/', httpOnly: true });
  res.clearCookie(CSRF_COOKIE_NAME, { secure: true, sameSite: 'lax', path: '/', httpOnly: false });
}
