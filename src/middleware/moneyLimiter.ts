import rateLimit from "express-rate-limit";

/**
 * Tighter rate limiter for money-handling endpoints. Stops card-testing
 * and brute-force withdrawal probing. Keyed by authenticated userId.
 *
 * 20 req/min should never be hit in normal operation — a single
 * checkout costs ~3 calls (initialize + verify + maybe redeem).
 *
 * SEC-P2 (audit run 6): pre-fix the keyGenerator fell back to
 * `ipKeyGenerator(req.ip ?? "anon")` when `req.userId` was missing.
 * Every caller is post-requireAuth today so the fallback was dead
 * code, but a foot-gun: a future "money" route mounted before
 * requireAuth would collapse every limiter bucket to the literal
 * string "anon" or to the proxy edge IP. Fail loudly instead —
 * Express converts the throw into a 500 at the misconfigured
 * route, which surfaces the bug at first request rather than
 * silently treating every caller as one bucket.
 */
export const moneyLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  message: { message: "Too many payment requests. Please wait a moment." },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req, _res) => {
    const userId = (req as any).userId as string | undefined;
    if (userId) return userId;
    throw new Error(
      "moneyLimiter requires req.userId — ensure requireAuth runs first",
    );
  },
});
