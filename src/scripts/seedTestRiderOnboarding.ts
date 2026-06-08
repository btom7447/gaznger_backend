/**
 * Backfill onboarding state for the test rider (rider@gaznger.com)
 * and link them to an Abkon Oil station so they bypass the v7 rider
 * onboarding wizard on next sign-in and land on /(rider)/(queue).
 *
 * `needsOnboarding(user)` returns false for a rider iff
 * `user.isOnboarded === true`, so that's the gate. We also approve
 * verification, set the RiderProfile to verified/available, and pin
 * homeStation to an Abkon station so dispatch prefers them for orders
 * out of that station.
 *
 * Run: npx ts-node src/scripts/seedTestRiderOnboarding.ts
 *
 * Safe to re-run — every write is idempotent.
 */
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import mongoose from "mongoose";
import User from "../models/User";
import RiderProfile from "../models/RiderProfile";
import GasStation from "../models/Station";

const RIDER_EMAIL = "ekemini.tom@gaznger.com";

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

  // ── 1. Locate the test rider user ──────────────────────────────────
  const rider = await User.findOne({ email: RIDER_EMAIL });
  if (!rider) {
    throw new Error(`No user found with email ${RIDER_EMAIL}.`);
  }
  console.log(
    `\nRider user: ${rider.displayName} (${rider._id}) phone=${rider.phone}`,
  );

  const userBefore = {
    isOnboarded: rider.isOnboarded,
    verificationStatus: rider.verificationStatus,
    accountStatus: rider.accountStatus,
    displayName: rider.displayName,
  };

  // Flip the onboarding-bypass gates.
  rider.isOnboarded = true;
  rider.verificationStatus = "approved";
  rider.verificationReviewedAt =
    rider.verificationReviewedAt ?? new Date();
  if (rider.accountStatus !== "active") {
    rider.accountStatus = "active";
  }
  if (!rider.displayName || rider.displayName === "Guest") {
    rider.displayName = "Test Rider";
  }
  await rider.save();

  console.log("\nUser before → after:");
  console.log(
    "  isOnboarded        :",
    userBefore.isOnboarded,
    "→",
    rider.isOnboarded,
  );
  console.log(
    "  verificationStatus :",
    userBefore.verificationStatus,
    "→",
    rider.verificationStatus,
  );
  console.log(
    "  accountStatus      :",
    userBefore.accountStatus,
    "→",
    rider.accountStatus,
  );

  // ── 2. Locate an Abkon Oil station to link to ──────────────────────
  const abkonVendor = await User.findOne({
    role: "vendor",
    $or: [
      { vendorBusinessName: /abkon/i },
      { displayName: /abkon/i },
      { email: /abkon/i },
    ],
  }).lean();
  if (!abkonVendor) {
    throw new Error("No Abkon vendor found — run seedAbkonOnboarding.ts first.");
  }

  const abkonStation = await GasStation.findOne({
    vendorId: abkonVendor._id,
  })
    .sort({ createdAt: 1 })
    .lean();
  if (!abkonStation) {
    throw new Error(
      "Abkon vendor has no stations — run seedAbkonOnboarding.ts to create a fallback.",
    );
  }
  console.log(
    `\nAbkon station: ${abkonStation.name} (${abkonStation._id}) lat=${abkonStation.location.lat} lng=${abkonStation.location.lng}`,
  );

  // ── 3. RiderProfile — verified + linked to Abkon home station ─────
  const existingProfile = await RiderProfile.findOne({ user: rider._id });
  const profileBefore = existingProfile
    ? {
        homeStation: String(existingProfile.homeStation ?? "(none)"),
        isVerified: existingProfile.isVerified,
        verificationStatus: existingProfile.verificationStatus,
        isAvailable: existingProfile.isAvailable,
      }
    : null;

  // Position the rider near the Abkon station so dispatch radius checks
  // pass during local order testing. ~0.4 km offset = "around the corner".
  const RIDER_LOCATION = {
    lat: abkonStation.location.lat + 0.003,
    lng: abkonStation.location.lng + 0.003,
  };

  const profile = await RiderProfile.findOneAndUpdate(
    { user: rider._id },
    {
      $set: {
        homeStation: abkonStation._id,
        isVerified: true,
        verificationStatus: "verified",
        isAvailable: true,
        currentLocation: RIDER_LOCATION,
      },
      $setOnInsert: {
        vehicleType: "motorcycle",
        vehiclePlate: "LSD-123GZ",
        vehicleBrand: "Bajaj",
        vehicleColor: "Red",
        vehicleYear: 2022,
        rating: 4.8,
        totalDeliveries: 0,
        bankAccount: {
          bankName: "Access Bank",
          accountNumber: "0123456789",
          accountName: "Test Rider",
        },
      },
    },
    { new: true, upsert: true },
  );

  console.log("\nRiderProfile before → after:");
  if (profileBefore) {
    console.log(
      "  homeStation        :",
      profileBefore.homeStation,
      "→",
      String(profile.homeStation),
    );
    console.log(
      "  isVerified         :",
      profileBefore.isVerified,
      "→",
      profile.isVerified,
    );
    console.log(
      "  verificationStatus :",
      profileBefore.verificationStatus,
      "→",
      profile.verificationStatus,
    );
    console.log(
      "  isAvailable        :",
      profileBefore.isAvailable,
      "→",
      profile.isAvailable,
    );
  } else {
    console.log("  (new RiderProfile created)");
    console.log("  homeStation        :", String(profile.homeStation));
    console.log("  vehiclePlate       :", profile.vehiclePlate);
  }
  console.log(
    `  currentLocation    : lat ${profile.currentLocation?.lat}, lng ${profile.currentLocation?.lng}`,
  );

  await mongoose.disconnect();
  console.log(
    "\nDone. Sign in as the test rider and you'll land on /(rider)/(queue) — affiliated to " +
      abkonStation.name +
      ".",
  );
}

run().catch((err) => {
  console.error("Failed:", err);
  process.exit(1);
});
