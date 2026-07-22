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
  // Without this check a login-2fa challenge (below, same secret) would also
  // verify as a valid refresh token.
  if (decoded.typ !== 'refresh') throw new Error('Invalid token type');
  return { sub: String(decoded.sub) };
}

/**
 * Short-lived proof that a user's password was already checked, minted by
 * /auth/login when twoFactorEnabled is set. /auth/login/verify-2fa trades it
 * (plus the emailed code) for a real session, so the second step never needs
 * the password again.
 */
export function signLoginChallenge(userId: string): string {
  return jwt.sign({ typ: 'login_2fa' }, env.jwt.refreshSecret, { subject: userId, expiresIn: '10m' });
}

export function verifyLoginChallenge(token: string): { sub: string } {
  const decoded = jwt.verify(token, env.jwt.refreshSecret) as jwt.JwtPayload;
  if (decoded.typ !== 'login_2fa') throw new Error('Invalid token type');
  return { sub: String(decoded.sub) };
}
