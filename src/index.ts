import dotenv from "dotenv";
// Only load .env.local in non-prod. On Railway / any prod platform the
// process env is already populated, and pointing dotenv at a non-existent
// .env.local prints a confusing "injecting env (0)" warning every boot.
if (process.env.NODE_ENV !== "production") {
  dotenv.config({ path: ".env.local" });
}

import http from "http";
import mongoose from "mongoose";
import app from "./app";
import { connectDB } from "./config/db";
import { initSocket } from "./socket";
import { startOrderWatchdog } from "./jobs/orderWatchdog";
import { startScheduledOrdersJob } from "./jobs/scheduledOrders";

// Hard requirements — server cannot boot without these. The rest of
// the integrations (Cloudinary, Firebase, Resend) degrade gracefully
// when their keys are missing: the relevant call is skipped and the
// rest of the request succeeds. Lets us deploy on Railway with only
// Mongo + JWT + Atlas configured and wire the others later.
const REQUIRED_ENV_VARS = [
  "MONGO_URI",
  "JWT_SECRET",
  "JWT_REFRESH_SECRET",
];

/**
 * Production-only required env vars. Treated as REQUIRED when
 * `NODE_ENV=production`; permitted to be missing in dev (the dev OTP
 * console fallback covers signup/login locally).
 *
 * SECURITY (audit A.1): without this gate, a prod deploy that forgot
 * to inject the WA credentials would silently flip into dev mode and
 * accept the fixed `123456` OTP for every account.
 */
const PROD_REQUIRED_ENV_VARS = [
  "WA_ACCESS_TOKEN",
  "WA_PHONE_NUMBER_ID",
];

/**
 * Paystack credentials. Required in production but the file accepts
 * either the legacy single-key (PAYSTACK_SECRET_KEY) or the explicit
 * test/live pair. We assert at boot that at least one valid pairing
 * exists in production — see assertPaystackKeys() below.
 *
 * SECURITY P0 (audit run 5): without this gate, a prod deploy with no
 * Paystack key boots successfully and every payment request fails at
 * runtime with an opaque 500 (or worse — webhook verification would
 * fail open, since the secret used for HMAC would be "").
 */
function assertPaystackKeysInProd() {
  if (process.env.NODE_ENV !== "production") return;
  const secret =
    process.env.PAYSTACK_SECRET_KEY_LIVE ?? process.env.PAYSTACK_SECRET_KEY;
  const pub =
    process.env.PAYSTACK_PUBLIC_KEY_LIVE ?? process.env.PAYSTACK_PUBLIC_KEY;
  if (!secret || !pub) {
    throw new Error(
      "Paystack production keys missing: need PAYSTACK_SECRET_KEY_LIVE " +
        "(or PAYSTACK_SECRET_KEY) AND PAYSTACK_PUBLIC_KEY_LIVE (or " +
        "PAYSTACK_PUBLIC_KEY). Refusing to boot — payment provider is " +
        "a launch-blocker feature, not optional.",
    );
  }
}

/**
 * Hard kill-switch date for the prod dev-OTP soft-launch bypass.
 * After this date the server REFUSES to boot when
 * ALLOW_DEV_OTP_IN_PROD=true in production. Buys us a known cliff
 * the flag can't outlive — closes SECURITY A1.
 *
 * Override via DEV_OTP_DEADLINE=YYYY-MM-DD only for genuine
 * extension cases (write a follow-up decision doc when you do).
 */
const DEFAULT_DEV_OTP_DEADLINE = "2026-06-30";

function validateEnv() {
  const missing = REQUIRED_ENV_VARS.filter((key) => !process.env[key]);
  const allowDevOtpInProd = process.env.ALLOW_DEV_OTP_IN_PROD === "true";
  if (process.env.NODE_ENV === "production" && !allowDevOtpInProd) {
    // Standard prod path: WA creds are mandatory.
    for (const key of PROD_REQUIRED_ENV_VARS) {
      if (!process.env[key]) missing.push(key);
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(", ")}`
    );
  }

  // Paystack keys are required in prod (asserted separately because the
  // pairing is "EITHER legacy key OR test/live pair").
  assertPaystackKeysInProd();

  // SECURITY A1 — hard cliff on the prod dev-OTP bypass. If the
  // operator hasn't replaced ALLOW_DEV_OTP_IN_PROD with real WA
  // creds by the deadline, refuse to boot. Failing closed is the
  // only safe default for an "accept 123456 for any phone" gate.
  if (process.env.NODE_ENV === "production" && allowDevOtpInProd) {
    const deadlineStr =
      process.env.DEV_OTP_DEADLINE ?? DEFAULT_DEV_OTP_DEADLINE;
    const deadline = new Date(deadlineStr + "T23:59:59Z");
    if (Number.isNaN(deadline.getTime())) {
      throw new Error(
        `DEV_OTP_DEADLINE is set but not a valid YYYY-MM-DD: ${deadlineStr}`,
      );
    }
    if (Date.now() > deadline.getTime()) {
      throw new Error(
        `ALLOW_DEV_OTP_IN_PROD is still true past the hard deadline ${deadlineStr}. ` +
          `Refusing to boot: replace ALLOW_DEV_OTP_IN_PROD with WA_ACCESS_TOKEN + WA_PHONE_NUMBER_ID, ` +
          `or extend DEV_OTP_DEADLINE with a written decision in docs/decisions/.`,
      );
    }
  }

  // Loud warn whenever the dev-OTP bypass is live — dev OR prod soft-launch.
  if (!process.env.WA_ACCESS_TOKEN || !process.env.WA_PHONE_NUMBER_ID) {
    const banner =
      process.env.NODE_ENV === "production" && allowDevOtpInProd
        ? "[startup] ⚠⚠⚠ PRODUCTION DEV-OTP BYPASS ACTIVE — ALLOW_DEV_OTP_IN_PROD=true. " +
          `Code 123456 is being accepted as a valid OTP for every signup/login. ` +
          `Hard cliff: ${process.env.DEV_OTP_DEADLINE ?? DEFAULT_DEV_OTP_DEADLINE} — server REFUSES TO BOOT past this date. ` +
          "Replace ALLOW_DEV_OTP_IN_PROD with WA_ACCESS_TOKEN + WA_PHONE_NUMBER_ID ASAP."
        : "[startup] WA_ACCESS_TOKEN/WA_PHONE_NUMBER_ID not set — dev OTP mode active. Fixed code 123456 will be accepted. This is a development-only bypass.";
    console.warn(banner);
  }
}

const PORT = process.env.PORT || 5000;

const startServer = async () => {
  validateEnv();
  await connectDB();

  const server = http.createServer(app);
  initSocket(server);
  startOrderWatchdog();
  startScheduledOrdersJob();

  server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });

  // Periodic re-warn when the prod dev-OTP bypass is on. Re-prints every
  // 30 min so the bypass can't drift out of operator awareness during a
  // long soft-launch. Drops itself the moment WA creds appear (treat env
  // as mutable across reboots — the next deploy will run validateEnv anew).
  if (
    process.env.NODE_ENV === "production" &&
    process.env.ALLOW_DEV_OTP_IN_PROD === "true" &&
    (!process.env.WA_ACCESS_TOKEN || !process.env.WA_PHONE_NUMBER_ID)
  ) {
    setInterval(
      () =>
        console.warn(
          "[runtime] dev-OTP bypass still active in production — replace ALLOW_DEV_OTP_IN_PROD with WA_ACCESS_TOKEN + WA_PHONE_NUMBER_ID ASAP",
        ),
      30 * 60 * 1000,
    );
  }

  const shutdown = async (signal: string) => {
    console.log(`Received ${signal}. Shutting down gracefully...`);
    server.close(async () => {
      await mongoose.connection.close();
      console.log("Server and DB connections closed.");
      process.exit(0);
    });
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
};

startServer();
