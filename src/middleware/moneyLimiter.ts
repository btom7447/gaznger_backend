import rateLimit from "express-rate-limit";

/**
 * Tighter rate limiter for money-handling endpoints. Stops card-testing
 * and brute-force withdrawal probing. Keyed by user when authenticated,
 * IP otherwise.
 *
 * 20 req/min should never be hit in normal operation — a single
 * checkout costs ~3 calls (initialize + verify + maybe redeem).
 */
export const moneyLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  message: { message: "Too many payment requests. Please wait a moment." },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req as any).userId ?? req.ip ?? "anon",
});
