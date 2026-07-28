import { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import WaitlistEntry from "../models/WaitlistEntry";

/**
 * Public pre-launch waitlist.
 *
 *   POST /api/waitlist   { email, role?, city? } → { ok: true }
 *
 * Unauthenticated — consumed by the marketing site (web/). Idempotent on
 * email: repeat signups update role/city instead of erroring, so the
 * response never reveals whether an address was already registered.
 */

const router = Router();

// Own limiter (stricter than apiLimiter): this is an anonymous write
// endpoint on the open internet. 10/hour per IP is generous for humans.
const isDev = process.env.NODE_ENV !== "production";
const waitlistLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: isDev ? 1000 : 10,
  message: { message: "Too many signups from this network. Try again later." },
  standardHeaders: true,
  legacyHeaders: false,
});

const waitlistSchema = z.object({
  email: z.email().max(254),
  role: z.enum(["customer", "vendor", "rider"]).default("customer"),
  city: z.string().trim().max(80).optional(),
  source: z.string().trim().max(40).optional(),
});

router.post("/", waitlistLimiter, async (req, res) => {
  const parsed = waitlistSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: "Enter a valid email address." });
  }
  const { email, role, city, source } = parsed.data;
  try {
    await WaitlistEntry.findOneAndUpdate(
      { email: email.toLowerCase() },
      {
        $set: { role, ...(city ? { city } : {}) },
        $setOnInsert: { email: email.toLowerCase(), source: source ?? "website" },
      },
      { upsert: true, new: true }
    );
    res.json({ ok: true });
  } catch (err) {
    console.error("[waitlist]", err);
    res.status(500).json({ message: "Could not save your signup. Try again." });
  }
});

export default router;
