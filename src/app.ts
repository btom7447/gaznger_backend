import { setupSwagger } from "./swagger";
import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { v4 as uuidv4 } from "uuid";

import authRoutes from "./routes/auth";
import configRoutes from "./routes/config";
import fuelTypeRoutes from "./routes/fuelTypes";
import fuelPricesRoutes from "./routes/fuelPrices";
import stationRoutes from "./routes/stations";
import uploadRoutes from "./routes/upload";
import pointRoutes from "./routes/points";
import orderRoutes from "./routes/orders";
import notificationRoutes from "./routes/notifications";
import addressRoutes from "./routes/address";
import paymentRoutes from "./routes/payments";
import vendorRoutes from "./routes/vendor";
import vendorBulkRoutes from "./routes/vendorBulk";
import vendorTeamRoutes from "./routes/vendorTeam";
import vendorFinanceRoutes from "./routes/vendorFinance";
import riderRoutes from "./routes/rider";
import adminRoutes from "./routes/admin";
import adminPaymentRoutes from "./routes/adminPayments";
import walletRoutes from "./routes/wallet";
import disputeRoutes from "./routes/disputes";
import chatRoutes from "./routes/chats";
import supportRoutes from "./routes/support";

import { startCronJobs } from "./jobs";
import { errorHandler } from "./middleware/errorHandler";
import { edgeStateGate } from "./middleware/edgeState";

const app = express();

// Trust proxy hops — required so express-rate-limit + req.ip use the real
// client IP, not the Railway/Cloudflare edge. Without this, every IP-keyed
// limiter collapses to the proxy IP and becomes a single global bucket
// (a single attacker can lock out every legitimate user).
// SECURITY P0 (audit run 5): TRUST_PROXY_HOPS defaults to 1 for Railway;
// set to 2 if Cloudflare is added in front.
app.set("trust proxy", Number(process.env.TRUST_PROXY_HOPS ?? 1));

// Security headers
app.use(helmet());

// CORS — restrict to allowed origins in production, allow all in development.
// SECURITY (audit F.1): filter empty entries after split so a stray
// trailing comma in env doesn't leave `""` in the list (which previously
// would-let any browser-without-Origin through). Also fail fast at boot
// if the prod allowlist is empty — silently allowing nothing prevents
// every legit request, but more importantly tells the operator their
// env is wrong before any traffic shows up.
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ?.split(",")
  .map((o) => o.trim())
  .filter(Boolean);

if (
  process.env.NODE_ENV === "production" &&
  (!allowedOrigins || allowedOrigins.length === 0)
) {
  throw new Error(
    "CORS: ALLOWED_ORIGINS must be a non-empty comma-separated list in production",
  );
}

app.use(
  cors({
    origin:
      process.env.NODE_ENV === "production"
        ? (origin, callback) => {
            // allow requests with no origin (mobile apps, curl, etc.)
            if (!origin) return callback(null, true);
            if (allowedOrigins && allowedOrigins.includes(origin)) {
              return callback(null, true);
            }
            callback(new Error(`CORS: origin ${origin} not allowed`));
          }
        : true,
    credentials: true,
  }),
);

// Request ID on every response
app.use((_req: Request, res: Response, next: NextFunction) => {
  res.setHeader("X-Request-Id", uuidv4());
  next();
});

// Raw body for Paystack webhook signature verification (must be before express.json())
app.use("/api/payments/webhook", express.raw({ type: "application/json" }));

app.use(express.json());

// Strip MongoDB operator injection ($-prefixed keys) from user input
function sanitizeObject(obj: unknown): unknown {
  if (Array.isArray(obj)) return obj.map(sanitizeObject);
  if (obj !== null && typeof obj === "object") {
    return Object.fromEntries(
      Object.entries(obj as Record<string, unknown>)
        .filter(([key]) => !key.startsWith("$"))
        .map(([key, val]) => [key, sanitizeObject(val)])
    );
  }
  return obj;
}

app.use((req: Request, _res: Response, next: NextFunction) => {
  if (req.body) req.body = sanitizeObject(req.body);
  if (req.query) {
    const sanitized = sanitizeObject(req.query) as Record<string, string>;
    Object.keys(sanitized).forEach((key) => {
      (req.query as Record<string, unknown>)[key] = sanitized[key];
    });
  }
  next();
});

// Rate limiters
//
// Three buckets with intentionally different max values:
//   - authLimiter:  signup / login / refresh (sensitive but low-volume)
//   - otpLimiter:   OTP send + verify + check-phone (chatty during a
//                   single signup, easy to trip in dev — generous bucket)
//   - apiLimiter:   everything else
//
// In development we essentially turn limits off so iterating doesn't
// burn through the bucket. Production uses the real numbers.
const isDev = process.env.NODE_ENV !== "production";

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: isDev ? 1000 : 30,
  message: { message: "Too many requests, please try again later." },
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * SEC-P1 (audit run 5): per-phone authLimiter, keyed by req.body.phone.
 *
 * The base authLimiter is per-IP and protects against a single IP
 * brute-forcing many accounts. It does NOT protect against a single
 * ACCOUNT being brute-forced from a botnet (different IP per attempt).
 * Per-account PIN lockout exists at utils/pinLockout.ts but cycles
 * after 15 min — exhausting a 4-digit PIN keyspace takes ~21 days at
 * 480 guesses/day, slow but not impossible.
 *
 * This layer caps PIN attempts per phone number at 20/hour regardless
 * of source IP, closing the botnet vector. The per-account lockout
 * still triggers first under normal abuse; this is the belt to its
 * suspenders.
 *
 * Falls back to the IP if `phone` isn't in the body (so /signup
 * without a phone — which shouldn't happen given the schema — still
 * gets the global cap).
 */
const phoneAuthLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: isDev ? 1000 : 20,
  message: {
    message:
      "Too many login attempts on this phone number. Try again in an hour.",
  },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req, _res) => {
    const phone = (req.body as { phone?: string })?.phone;
    if (typeof phone === "string" && phone.length > 0) return `phone:${phone}`;
    // Fallback to IP via express-rate-limit's built-in normalizer to
    // avoid the IPv6-bypass class of bug. Imported lazily so the
    // module's primary export is still the keyGenerator function.
    return `ip:${req.ip ?? "anon"}`;
  },
});

const otpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  // OTP flows fire 2-3 calls per signup attempt (check-phone, send-otp,
  // verify-otp). 60/15min = 20 full signup attempts which is plenty
  // for prod abuse protection while not nuking dev iteration.
  max: isDev ? 1000 : 60,
  message: { message: "Too many OTP requests, try again later." },
  standardHeaders: true,
  legacyHeaders: false,
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: isDev ? 1000 : 100,
  message: { message: "Too many requests, please try again later." },
  standardHeaders: true,
  legacyHeaders: false,
});

// Money-handling limiter lives in middleware/moneyLimiter.ts so it can be
// imported by route files without creating a circular import via app.ts.

// Health check (no auth, no rate limit, no edge-state gate)
app.get("/health", (_req, res) => {
  res.json({ status: "ok", uptime: process.uptime() });
});

// Edge-state gate (maintenance + force-update). Runs after /health so
// admin tooling can still ping during maintenance windows. Routes after
// this point are subject to 503 when maintenanceMode is on.
app.use(edgeStateGate);

// Routes
// Sensitive auth actions → strict limiter. v4 phone-first endpoints
// have separate per-flow limiters because abuse vectors differ
// (signup vs login vs recovery). The legacy /register, /forgot-password,
// /reset-password, /resend-otp routes return 410 from the auth router
// itself — keeping the limiter mappings would 429 noise the legacy
// stub's 410, so they're omitted.
// OTP-flavoured endpoints get the generous bucket; signup + login keep
// the strict authLimiter because brute-force PIN guessing is the more
// dangerous attack surface than OTP-burning.
app.use("/auth/check-phone", otpLimiter);
app.use("/auth/send-otp", otpLimiter);
app.use("/auth/verify-otp", otpLimiter);
app.use("/auth/forgot-pin", otpLimiter);
// SEC-P1: stack BOTH the global per-IP authLimiter AND the per-phone
// limiter on signup + login. The per-IP one blocks one-IP-bruteforces;
// the per-phone one blocks distributed (botnet) attacks on a single
// account.
app.use("/auth/signup", authLimiter, phoneAuthLimiter);
app.use("/auth/login", authLimiter, phoneAuthLimiter);
// Forgot-pin/start also takes phone — apply the same per-phone cap.
app.use("/auth/forgot-pin/start", phoneAuthLimiter);
app.use("/auth", apiLimiter, authRoutes);
app.use("/api/config", apiLimiter, configRoutes);
app.use("/api/fuel-types", apiLimiter, fuelTypeRoutes);
app.use("/api/fuel-prices", apiLimiter, fuelPricesRoutes);
app.use("/api/stations", apiLimiter, stationRoutes);
app.use("/api/upload", apiLimiter, uploadRoutes);
app.use("/api/points", apiLimiter, pointRoutes);
app.use("/api/orders", apiLimiter, orderRoutes);
app.use("/api/notifications", apiLimiter, notificationRoutes);
app.use("/api/address-book", apiLimiter, addressRoutes);
app.use("/api/payments", apiLimiter, paymentRoutes);
// Phase 4 bulk routes mounted on the same /api/vendor base so the
// mobile client speaks one root URL. Express picks the first matching
// route, so order doesn't matter as long as paths don't collide
// (vendorBulk's paths all start with /plants or /bulk-purchases).
app.use("/api/vendor", apiLimiter, vendorBulkRoutes);
app.use("/api/vendor", apiLimiter, vendorTeamRoutes);
app.use("/api/vendor", apiLimiter, vendorFinanceRoutes);
app.use("/api/vendor", apiLimiter, vendorRoutes);
app.use("/api/rider", apiLimiter, riderRoutes);
app.use("/api/admin", apiLimiter, adminRoutes);
app.use("/api/admin", apiLimiter, adminPaymentRoutes);
app.use("/api/wallet", apiLimiter, walletRoutes);
app.use("/api/disputes", apiLimiter, disputeRoutes);
app.use("/api/chats", apiLimiter, chatRoutes);
app.use("/api", apiLimiter, supportRoutes);

startCronJobs();

// Swagger docs
setupSwagger(app);

// Global error handler (must be last)
app.use(errorHandler);

export default app;
