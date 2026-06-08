/**
 * Backfill onboarding state for the existing Abkon Oil vendor so they
 * bypass the v7 onboarding wizard on next sign-in and land straight on
 * Vendor Today.
 *
 * `needsOnboarding(user)` returns false for a vendor iff
 * `vendorBusinessName` is set, so the only required write is that
 * field. We also set displayName + email if blank, approve verification
 * so the bootstrap router skips the verification-pending screen, and
 * make sure at least one Station exists so the Today screen has
 * something to render.
 *
 * Run: npx ts-node src/scripts/seedAbkonOnboarding.ts
 *
 * Safe to re-run — every write is idempotent (set-if-missing).
 */
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import mongoose from "mongoose";
import User from "../models/User";
import GasStation from "../models/Station";

const BUSINESS_NAME = "Abkon Oil Ltd";
const BUSINESS_EMAIL = "ops@abkonoil.ng";
const DISPLAY_NAME = "Funmi Adebayo";
const BANK = {
  bankName: "GTBank",
  accountNumber: "0123456789",
  accountName: "ABKON OIL LIMITED",
};

const FALLBACK_STATION = {
  name: "Abkon Oil — Ikot Ekpene",
  address: "12 Aba Road, Ikot Ekpene",
  state: "Akwa Ibom",
  lga: "Ikot Ekpene",
  location: { lat: 5.1808, lng: 7.7167 },
  operatingHours: { open: "06:00", close: "22:00" },
  isActive: true,
  verified: true,
};

async function run() {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI missing from .env.local");
  if (/prod|production/i.test(uri) && process.env.SEED_FORCE !== "1") {
    throw new Error(
      "Refusing to seed against a prod URI without SEED_FORCE=1",
    );
  }

  await mongoose.connect(uri, { serverSelectionTimeoutMS: 8000 });
  console.log("Connected:", mongoose.connection.host);
  console.log("Database:", mongoose.connection.name);

  // Locate the existing Abkon vendor.
  const vendor = await User.findOne({
    role: "vendor",
    $or: [
      { displayName: /abkon/i },
      { email: /abkon/i },
      { vendorBusinessName: /abkon/i },
    ],
  });

  if (!vendor) {
    throw new Error(
      "No Abkon vendor found (looked at displayName / email / vendorBusinessName).",
    );
  }
  console.log(
    `\nVendor: ${vendor.displayName} (${vendor._id}) phone=${vendor.phone}`,
  );

  // Backfill the onboarding-bypass fields. Only write what's missing
  // so re-runs don't trample manual edits.
  const before = {
    displayName: vendor.displayName,
    email: vendor.email,
    vendorBusinessName: vendor.vendorBusinessName,
    verificationStatus: vendor.verificationStatus,
    accountStatus: vendor.accountStatus,
    bank: vendor.vendorBankAccount?.accountName,
  };

  if (!vendor.vendorBusinessName) {
    vendor.vendorBusinessName = BUSINESS_NAME;
  }
  if (!vendor.email) {
    vendor.email = BUSINESS_EMAIL;
  }
  if (!vendor.displayName || vendor.displayName === "Guest") {
    vendor.displayName = DISPLAY_NAME;
  }
  // Approve so the bootstrap router lands them on /(vendor)/(today).
  vendor.verificationStatus = "approved";
  vendor.verificationReviewedAt = vendor.verificationReviewedAt ?? new Date();

  // vendorVerification subdoc (used by admin tooling).
  if (
    !vendor.vendorVerification ||
    vendor.vendorVerification.status === "none"
  ) {
    vendor.vendorVerification = {
      status: "verified",
      documents: [],
      submittedAt: new Date(),
      reviewedAt: new Date(),
    };
  } else if (vendor.vendorVerification.status !== "verified") {
    vendor.vendorVerification.status = "verified";
    vendor.vendorVerification.reviewedAt = new Date();
  }

  if (
    !vendor.vendorBankAccount ||
    !vendor.vendorBankAccount.accountNumber
  ) {
    vendor.vendorBankAccount = BANK;
  }

  if (vendor.accountStatus !== "active") {
    vendor.accountStatus = "active";
  }

  await vendor.save();

  console.log("\nVendor before → after:");
  console.log("  displayName        :", before.displayName, "→", vendor.displayName);
  console.log("  email              :", before.email, "→", vendor.email);
  console.log("  vendorBusinessName :", before.vendorBusinessName, "→", vendor.vendorBusinessName);
  console.log("  verificationStatus :", before.verificationStatus, "→", vendor.verificationStatus);
  console.log("  accountStatus      :", before.accountStatus, "→", vendor.accountStatus);
  console.log("  bank.accountName   :", before.bank, "→", vendor.vendorBankAccount?.accountName);

  // Ensure at least one station so Vendor Today has something to show.
  const stationCount = await GasStation.countDocuments({ vendorId: vendor._id });
  console.log(`\nExisting stations: ${stationCount}`);
  if (stationCount === 0) {
    const station = await GasStation.create({
      vendorId: vendor._id,
      ...FALLBACK_STATION,
    });
    console.log(`  + created fallback station: ${station.name} (${station._id})`);
  } else {
    console.log("  (skip — vendor already has at least one station)");
  }

  await mongoose.disconnect();
  console.log("\nDone. Sign in as this vendor and you'll land on /(vendor)/(today) without seeing the wizard.");
}

run().catch((err) => {
  console.error("Failed:", err);
  process.exit(1);
});
