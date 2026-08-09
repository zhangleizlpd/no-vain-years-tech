/**
 * Parse CORS_ALLOWED_ORIGINS into the shape `@fastify/cors` expects.
 *
 *  - `*`             → boolean `true` (permissive; dev only)
 *  - `a,b, c`        → `['a', 'b', 'c']` (strict allowlist)
 *  - empty / unset   → boolean `false` (no Access-Control-Allow-Origin emitted)
 *
 * Reflect-back (`(origin, cb) => cb(null, true)`) is intentionally NOT supported
 * — it silently disables CORS by trusting the request's `Origin` header.
 */
export function parseOrigins(raw: string | undefined): true | false | string[] {
  if (raw === undefined) return false;
  const trimmed = raw.trim();
  if (trimmed === '') return false;
  if (trimmed === '*') return true;
  const origins = trimmed
    .split(',')
    .map((o) => o.trim())
    .filter((o) => o.length > 0);
  return origins.length === 0 ? false : origins;
}
