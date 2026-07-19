import type { NextFunction, Request, Response } from 'express';
import { HttpError } from '../lib/errors';
import { verifyAccess, type AccountType } from '../lib/jwt';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: { id: string; accountType: AccountType; email: string };
    }
  }
}

/** Require a valid `Authorization: Bearer <accessToken>` and attach req.user. */
export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    throw new HttpError(401, 'Missing or invalid Authorization header');
  }
  try {
    const payload = verifyAccess(header.slice(7));
    req.user = { id: payload.sub, accountType: payload.accountType, email: payload.email };
    next();
  } catch {
    // A 401 tells the mobile client to clear its session and return to Login.
    throw new HttpError(401, 'Session expired or invalid');
  }
}

/** Restrict a route to one or more account types (use after requireAuth). */
export function requireAccountType(...accountTypes: AccountType[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user || !accountTypes.includes(req.user.accountType)) {
      throw new HttpError(403, 'You do not have access to this resource');
    }
    next();
  };
}
