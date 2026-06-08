import { Request, Response } from "express";
import crypto from "crypto";
import IdempotencyRecord from "../models/IdempotencyRecord";

/**
 * Wrap an auth-mutation handler with idempotency-response caching.
 *
 * The middleware-level `idempotencyKey` validator stashes the header
 * on `req.idempotencyKey`. This helper:
 *   1. Computes a cacheKey scoped to (key, path, actor) so an
 *      attacker who observes the UUID can't replay it against the
 *      same path to claim a cached session for someone else.
 *   2. Returns the cached body if the same UUID + actor already
 *      produced a response within the TTL.
 *   3. Otherwise runs the handler and caches the (status, body).
 *
 * SECURITY P0 (audit run 5): the previous cacheKey was just
 * `${key}:${path}`. With pre-auth signup/login/reset routes caching
 * full responses (including accessToken + refreshToken) for 24h, an
 * attacker who saw a victim's Idempotency-Key UUID via logs or crash
 * reports could replay it and receive the cached session tokens —
 * full account takeover without credentials.
 *
 * The fix: bind cacheKey to an actor identity (req.userId for
 * authenticated routes, or the caller-supplied `bindTo` for pre-auth
 * routes like signup which pass req.body.phone). Drop pre-auth TTL
 * to 15 min — long enough to absorb a real "background app, retry"
 * but short enough to bound the replay window if a UUID leaks.
 */
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
/** Pre-auth routes (signup/login/forgot-pin) override default with this. */
export const PRE_AUTH_TTL_MS = 15 * 60 * 1000;

export interface IdempotentHandlerResult {
  statusCode: number;
  body: unknown;
}

/**
 * Build a cache key that includes an actor identity. We SHA-256 the
 * combination so phone numbers / userIds don't appear in plaintext
 * in the IdempotencyRecord collection (defence-in-depth against an
 * index leak revealing the active-users set).
 */
function buildCacheKey(idempotencyKey: string, path: string, actor: string): string {
  const input = `${idempotencyKey}:${path}:${actor}`;
  return crypto.createHash("sha256").update(input).digest("hex");
}

export async function withIdempotency(
  req: Request,
  res: Response,
  handler: () => Promise<IdempotentHandlerResult>,
  opts: { ttlMs?: number; required?: boolean; bindTo?: string } = {}
): Promise<void> {
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const key = req.idempotencyKey;

  if (!key) {
    if (opts.required) {
      res.status(400).json({ message: "Missing required Idempotency-Key header" });
      return;
    }
    // No key — execute without caching.
    const result = await handler();
    res.status(result.statusCode).json(result.body);
    return;
  }

  // SECURITY P0: bind to an actor identity. Order of preference:
  //   1. caller-supplied `bindTo` (pre-auth routes pass req.body.phone)
  //   2. req.userId (set by requireAuth for authenticated routes)
  //   3. fall back to "anon" — degraded mode, but the request also
  //      has nothing to leak in this case (no auth response body).
  const actor = opts.bindTo ?? req.userId ?? "anon";
  const cacheKey = buildCacheKey(key, req.path, actor);

  // Hit?
  const cached = await IdempotencyRecord.findOne({ cacheKey }).lean();
  if (cached) {
    res.status(cached.statusCode).json(cached.body);
    return;
  }

  // Miss — execute, then store.
  const result = await handler();
  // Best-effort write — if Mongo's down or the unique-index race fires,
  // we still respond. The original handler already produced its output.
  try {
    await IdempotencyRecord.create({
      cacheKey,
      statusCode: result.statusCode,
      body: result.body,
      expiresAt: new Date(Date.now() + ttlMs),
    });
  } catch {
    // Concurrent insert with the same key from a duplicate POST is
    // benign — the second writer loses the race but the first cached
    // doc satisfies any future replay.
  }
  res.status(result.statusCode).json(result.body);
}
