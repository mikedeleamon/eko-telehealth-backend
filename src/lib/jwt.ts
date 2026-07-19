import jwt from 'jsonwebtoken';
import { env } from '../config/env';

export type AccountType = 'Patient' | 'Doctor' | 'Admin';

export interface AccessPayload {
  sub: string;
  accountType: AccountType;
  email: string;
}

interface SessionUser {
  id: string;
  accountType: AccountType;
  email: string;
}

/** Mint the access + refresh pair returned by /auth/login and /auth/signup. */
export function signSession(user: SessionUser): { accessToken: string; refreshToken: string } {
  const accessToken = jwt.sign({ accountType: user.accountType, email: user.email }, env.jwt.accessSecret, {
    subject: user.id,
    expiresIn: env.jwt.accessTtl,
  });
  const refreshToken = jwt.sign({ typ: 'refresh' }, env.jwt.refreshSecret, {
    subject: user.id,
    expiresIn: env.jwt.refreshTtl,
  });
  return { accessToken, refreshToken };
}

export function verifyAccess(token: string): AccessPayload {
  const decoded = jwt.verify(token, env.jwt.accessSecret) as jwt.JwtPayload;
  return { sub: String(decoded.sub), accountType: decoded.accountType as AccountType, email: String(decoded.email) };
}

export function verifyRefresh(token: string): { sub: string } {
  const decoded = jwt.verify(token, env.jwt.refreshSecret) as jwt.JwtPayload;
  return { sub: String(decoded.sub) };
}
