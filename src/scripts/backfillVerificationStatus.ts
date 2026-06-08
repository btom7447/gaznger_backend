/**
 * Backfill User.verificationStatus from the legacy schema-split state.
 *
 * Before the fix in `adminPayments.ts:246`, the admin "Verify" action
 * only wrote to RiderProfile.verificationStatus / isVerified (riders) or
 * User.vendorVerification.status (vendors). The mobile auth router reads
 * User.verificationStatus exclusively, so any rider/vendor verified
 * pre-fix had a half-written state:
 *
 *   RiderProfile.verificationStatus = "verified"      ← used by /availability
 *   User.verificationStatus         = undefined        ← used by postAuthPathFor
 *
 * Result: every login routed them back to /(auth)/verification/pending
 * even though they'd been approved.
 *
 * This script reconciles by mirroring the truth from the per-role doc
 * onto User.verificationStatus. Rules:
 *
 *   RIDERS
 *     RiderProfile.verificationStatus === "verified"
 *       AND User.verificationStatus !== "approved"
 *         → User.verificationStatus = "approved"
 *
 *     RiderProfile.verificationStatus === "rejected"
 *       AND User.verificationStatus !== "rejected"
 *         → User.verificationStatus = "rejected"
 *         + User.verificationReason = RiderProfile.verificationNote
 *
 *   VENDORS
 *     User.vendorVerification.status === "verified"
 *       AND User.verificationStatus !== "approved"
 *         → User.verificationStatus = "approved"
 *
 *     User.vendorVerification.status === "rejected"
 *       AND User.verificationStatus !== "rejected"
 *         → User.verificationStatus = "rejected"
 *
 * Idempotent — re-running produces no further writes once everyone is
 * mirrored. Logs a per-user diff line + a final summary.
 *
 * Run: npm run backfill:verification
 *      (or: npx ts-node src/scripts/backfillVerificationStatus.ts)
 *
 * Flags:
 *   --dry-run    print what WOULD change, write nothing
 *   --verbose    print one line per touched user (default: summary only)
 */
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import mongoose from "mongoose";
import User from "../models/User";
import RiderProfile from "../models/RiderProfile";

interface BackfillSummary {
  ridersChecked: number;
  ridersApproved: number;
  ridersRejected: number;
  ridersAlreadyMirrored: number;
  vendorsChecked: number;
  vendorsApproved: number;
  vendorsRejected: number;
  vendorsAlreadyMirrored: number;
  skipped: number;
}

async function run() {
  const dryRun = process.argv.includes("--dry-run");
  const verbose = process.argv.includes("--verbose");

  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI missing from .env.local");
  if (/prod|production/i.test(uri) && process.env.SEED_FORCE !== "1") {
    throw new Error(
      "Refusing to backfill against a prod URI without SEED_FORCE=1",
    );
  }

  await mongoose.connect(uri, { serverSelectionTimeoutMS: 8000 });
  console.log("Connected:", mongoose.connection.host);
  console.log("Database:", mongoose.connection.name);
  console.log(
    "Mode:    ",
    dryRun ? "DRY RUN (no writes)" : "LIVE (will write)",
  );
  console.log("");

  const summary: BackfillSummary = {
    ridersChecked: 0,
    ridersApproved: 0,
    ridersRejected: 0,
    ridersAlreadyMirrored: 0,
    vendorsChecked: 0,
    vendorsApproved: 0,
    vendorsRejected: 0,
    vendorsAlreadyMirrored: 0,
    skipped: 0,
  };

  // ── RIDERS ──────────────────────────────────────────────────────────
  console.log("── Riders ──────────────────────────────────────────────");
  // Pull every RiderProfile whose verificationStatus is non-null. The
  // batch is small enough (~hundreds at most for v1) that an in-memory
  // pass beats writing a single aggregate.
  const riderProfiles = await RiderProfile.find({
    verificationStatus: { $in: ["verified", "rejected"] },
  })
    .select("user verificationStatus verificationNote")
    .lean();

  for (const profile of riderProfiles) {
    summary.ridersChecked += 1;
    const user = await User.findById(profile.user).select(
      "_id role displayName verificationStatus verificationReason",
    );
    if (!user || user.role !== "rider") {
      summary.skipped += 1;
      continue;
    }

    const desired =
      profile.verificationStatus === "verified" ? "approved" : "rejected";

    if (user.verificationStatus === desired) {
      summary.ridersAlreadyMirrored += 1;
      continue;
    }

    if (verbose || dryRun) {
      console.log(
        `  ${user.displayName ?? "(no name)"} (${String(user._id)}) ` +
          `User.verificationStatus: ${user.verificationStatus ?? "—"} → ${desired}`,
      );
    }

    if (!dryRun) {
      user.verificationStatus = desired;
      if (desired === "rejected") {
        user.verificationReason = profile.verificationNote ?? undefined;
      }
      user.verificationReviewedAt =
        user.verificationReviewedAt ?? new Date();
      await user.save();
    }

    if (desired === "approved") summary.ridersApproved += 1;
    else summary.ridersRejected += 1;
  }

  console.log(
    `  ${riderProfiles.length} rider profiles scanned · ` +
      `${summary.ridersApproved} approved · ` +
      `${summary.ridersRejected} rejected · ` +
      `${summary.ridersAlreadyMirrored} already mirrored`,
  );
  console.log("");

  // ── VENDORS ─────────────────────────────────────────────────────────
  console.log("── Vendors ─────────────────────────────────────────────");
  const vendorUsers = await User.find({
    role: "vendor",
    "vendorVerification.status": { $in: ["verified", "rejected"] },
  }).select(
    "_id role displayName verificationStatus verificationReason vendorVerification",
  );

  for (const user of vendorUsers) {
    summary.vendorsChecked += 1;
    const vendorStatus = user.vendorVerification?.status;
    const desired = vendorStatus === "verified" ? "approved" : "rejected";

    if (user.verificationStatus === desired) {
      summary.vendorsAlreadyMirrored += 1;
      continue;
    }

    if (verbose || dryRun) {
      console.log(
        `  ${user.displayName ?? "(no name)"} (${String(user._id)}) ` +
          `vendorVerification=${vendorStatus} · ` +
          `User.verificationStatus: ${user.verificationStatus ?? "—"} → ${desired}`,
      );
    }

    if (!dryRun) {
      user.verificationStatus = desired;
      if (desired === "rejected") {
        user.verificationReason =
          (user.vendorVerification as any)?.note ?? undefined;
      }
      user.verificationReviewedAt =
        user.verificationReviewedAt ??
        (user.vendorVerification as any)?.reviewedAt ??
        new Date();
      await user.save();
    }

    if (desired === "approved") summary.vendorsApproved += 1;
    else summary.vendorsRejected += 1;
  }

  console.log(
    `  ${vendorUsers.length} vendor users scanned · ` +
      `${summary.vendorsApproved} approved · ` +
      `${summary.vendorsRejected} rejected · ` +
      `${summary.vendorsAlreadyMirrored} already mirrored`,
  );
  console.log("");

  // ── SUMMARY ─────────────────────────────────────────────────────────
  const totalWrites =
    summary.ridersApproved +
    summary.ridersRejected +
    summary.vendorsApproved +
    summary.vendorsRejected;

  console.log("── Summary ─────────────────────────────────────────────");
  console.log(
    `  Riders   : checked ${summary.ridersChecked} · ` +
      `wrote ${summary.ridersApproved + summary.ridersRejected} · ` +
      `mirrored ${summary.ridersAlreadyMirrored}`,
  );
  console.log(
    `  Vendors  : checked ${summary.vendorsChecked} · ` +
      `wrote ${summary.vendorsApproved + summary.vendorsRejected} · ` +
      `mirrored ${summary.vendorsAlreadyMirrored}`,
  );
  if (summary.skipped > 0) {
    console.log(`  Skipped  : ${summary.skipped} (missing User or wrong role)`);
  }
  console.log(`  Total writes: ${totalWrites}${dryRun ? " (DRY RUN)" : ""}`);

  await mongoose.disconnect();

  if (totalWrites === 0) {
    console.log("\nNo changes needed — every approved/rejected status is already mirrored.");
  } else if (dryRun) {
    console.log(
      "\nRe-run without --dry-run to apply these changes.",
    );
  } else {
    console.log(
      "\nDone. Affected users will route correctly on their next login + the dev log in `postAuthPathFor` will confirm.",
    );
  }
}

run().catch((err) => {
  console.error("Failed:", err);
  process.exit(1);
});
