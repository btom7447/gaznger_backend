import rateLimit from "express-rate-limit";

/**
 * SEC-P1 (audit run 5): per-user upload limiter.
 *
 * Pre-fix /api/upload/image (5MB cap) + /api/upload/media (50MB cap)
 * had only the global apiLimiter (100/min PER USER, not per upload).
 * One authenticated user burns 100 × 50MB = 5GB/min of Cloudinary
 * egress + 100 concurrent 50MB multer buffers in RAM (OOM).
 *
 * 30 image / 10 media per 10 min is generous for legit use
 * (uploading 5-10 KYC docs in one session). Mounted via the
 * existing apiLimiter pattern in app.ts upload routes — see
 * upload.ts where it gets attached per route.
 */
export const uploadImageLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 30,
  message: {
    message: "Too many image uploads. Try again in a few minutes.",
  },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req, _res) => {
    const userId = (req as any).userId as string | undefined;
    if (userId) return userId;
    throw new Error(
      "uploadImageLimiter requires req.userId — ensure requireAuth runs first",
    );
  },
});

export const uploadMediaLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 10,
  message: {
    message: "Too many media uploads. Try again in a few minutes.",
  },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req, _res) => {
    const userId = (req as any).userId as string | undefined;
    if (userId) return userId;
    throw new Error(
      "uploadMediaLimiter requires req.userId — ensure requireAuth runs first",
    );
  },
});

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
