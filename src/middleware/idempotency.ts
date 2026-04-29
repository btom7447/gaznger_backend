import { Request, Response, NextFunction } from "express";

/**
 * Idempotency-Key middleware.
 *
 * For state-changing money endpoints, the client should pass a UUID v4
 * in the `Idempotency-Key` header. The handler then forwards it to the
 * wallet helpers, which dedupe on the matching unique index in the
 * Transactions collection.
 *
 * This middleware does only the surface validation:
 *   - Required: a missing key returns 400 in `enforce` mode (default
 *     OFF — `enforce=true` only on the highest-stakes routes).
 *   - Format: must look like a UUID v4 (lenient regex).
 *
 * The actual replay-safety lives in `utils/wallet.ts:findByIdempotencyKey`.
 */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface IdempotencyOpts {
  /** When true, missing key → 400. Default false (key is optional). */
  enforce?: boolean;
}

export function idempotencyKey(opts: IdempotencyOpts = {}) {
  return (req: Request, res: Response, next: NextFunction) => {
    const raw = req.headers["idempotency-key"];
    const key = Array.isArray(raw) ? raw[0] : raw;

    if (!key) {
      if (opts.enforce) {
        return res
          .status(400)
          .json({ message: "Missing required Idempotency-Key header" });
      }
      return next();
    }
    if (!UUID_RE.test(key.trim())) {
      return res
        .status(400)
        .json({ message: "Idempotency-Key must be a UUID v4" });
    }

    // Stash on the request so handlers can pass it to wallet helpers
    // without re-reading the header.
    req.idempotencyKey = key.trim();
    next();
  };
}

declare global {
  namespace Express {
    interface Request {
      idempotencyKey?: string;
    }
  }
}
