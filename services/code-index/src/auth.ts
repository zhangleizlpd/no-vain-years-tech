import { timingSafeEqual } from 'node:crypto';
import { serviceToken } from './config.js';

/** Pull the bearer token out of an Authorization header (`Bearer <token>`). */
export function extractToken(authHeader?: string): string | null {
  if (!authHeader) return null;
  const m = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
  return m ? m[1] : null;
}

/** Constant-time check against the configured service token. Fail-closed: an
 *  unset configured token or a missing presented token never authorizes. */
export function isAuthorized(presented: string | null): boolean {
  const expected = serviceToken();
  if (!expected || !presented) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false; // length is not secret; content is
  return timingSafeEqual(a, b);
}
