import rateLimit, { ipKeyGenerator } from "express-rate-limit";

/**
 * Tighter rate limiter for money-handling endpoints. Stops card-testing
 * and brute-force withdrawal probing. Keyed by user when authenticated,
 * IP otherwise.
 *
 * 20 req/min should never be hit in normal operation — a single
 * checkout costs ~3 calls (initialize + verify + maybe redeem).
 *
 * NOTE: Custom keyGenerators that fall back to the request IP must run
 * the IP through `ipKeyGenerator` so IPv6 addresses get normalised by
 * subnet — otherwise IPv6 callers can bypass the limit by varying the
 * trailing 64 bits. Triggers ERR_ERL_KEY_GEN_IPV6 in v8+ if missed.
 */
export const moneyLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  message: { message: "Too many payment requests. Please wait a moment." },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req, res) =>
    (req as any).userId ?? ipKeyGenerator(req.ip ?? "anon"),
});
