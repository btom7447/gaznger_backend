import { Request, Response } from "express";
import IdempotencyRecord from "../models/IdempotencyRecord";

/**
 * Wrap an auth-mutation handler with idempotency-response caching.
 *
 * The middleware-level `idempotencyKey` validator stashes the header
 * on `req.idempotencyKey`. This helper:
 *   1. Computes a cacheKey scoped to the path so the same UUID can be
 *      reused across different mutations without colliding.
 *   2. Returns the cached body if the same UUID already produced a
 *      response within the TTL.
 *   3. Otherwise runs the handler and caches the (status, body).
 *
 * Default TTL = 24h. 24h is long enough that "background app, retry
 * in the morning" doesn't double-fire, but short enough that we don't
 * keep stale data forever.
 */
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

export interface IdempotentHandlerResult {
  statusCode: number;
  body: unknown;
}

export async function withIdempotency(
  req: Request,
  res: Response,
  handler: () => Promise<IdempotentHandlerResult>,
  opts: { ttlMs?: number; required?: boolean } = {}
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

  // Scope the cache key to the path so the same UUID can be safely
  // reused on different endpoints (e.g. same key on signup + start-otp
  // doesn't cross-pollute).
  const cacheKey = `${key}:${req.path}`;

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
