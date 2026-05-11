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

const REQUIRED_ENV_VARS = [
  "MONGO_URI",
  "JWT_SECRET",
  "JWT_REFRESH_SECRET",
  "CLOUDINARY_CLOUD_NAME",
  "CLOUDINARY_API_KEY",
  "CLOUDINARY_API_SECRET",
  "FIREBASE_PROJECT_ID",
  "FIREBASE_PRIVATE_KEY",
  "FIREBASE_CLIENT_EMAIL",
  "RESEND_API_KEY",
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
  // Loud warn whenever the dev-OTP bypass is live — dev OR prod soft-launch.
  if (!process.env.WA_ACCESS_TOKEN || !process.env.WA_PHONE_NUMBER_ID) {
    const banner =
      process.env.NODE_ENV === "production" && allowDevOtpInProd
        ? "[startup] ⚠⚠⚠ PRODUCTION DEV-OTP BYPASS ACTIVE — ALLOW_DEV_OTP_IN_PROD=true. " +
          "Code 123456 is being accepted as a valid OTP for every signup/login. " +
          "Unset ALLOW_DEV_OTP_IN_PROD the moment WA_ACCESS_TOKEN + WA_PHONE_NUMBER_ID are configured. " +
          "This is a soft-launch escape hatch, NOT a long-term setting."
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
