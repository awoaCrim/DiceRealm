import express from 'express';

export const BODY_BUDGETS = {
  auth: '16kb', campaigns: '32kb', characters: '256kb', world: '64kb', turn: '64kb', archive: '64kb', combat: '64kb', rules: '64kb', ai: '8kb', aiProvider: '16kb',
} as const;

/** Attach only to routes that consume JSON, after authentication/role checks. */
export function jsonBodyBudget(limit: keyof typeof BODY_BUDGETS | string): express.RequestHandler {
  const value = limit in BODY_BUDGETS ? BODY_BUDGETS[limit as keyof typeof BODY_BUDGETS] : limit;
  return express.json({ limit: value, strict: true, type: 'application/json' });
}
