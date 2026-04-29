/**
 * Fix Test Rider for Order Flow Testing
 *
 * Updates rider@gaznger.com and the test station so the full order flow
 * works end-to-end: place order → auto-confirm → dispatch → rider accepts.
 *
 * Run: npx ts-node src/scripts/fixTestRider.ts
 */

import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
import mongoose from "mongoose";
import User from "../models/User";
import RiderProfile from "../models/RiderProfile";
import GasStation from "../models/Station";

// Station coords (Victoria Island): lat 6.4281, lng 3.4219
// Rider placed ~1.5 km from station for reliable dispatch within any radius setting
const RIDER_LOCATION = { lat: 6.4310, lng: 3.4180 };

async function main() {
  await mongoose.connect(process.env.MONGO_URI!);
  console.log("Connected to MongoDB\n");

  // ── 1. Find rider user ──────────────────────────────────────────────────
  const riderUser = await User.findOne({ email: "rider@gaznger.com" }).lean();
  if (!riderUser) {
    console.error("rider@gaznger.com not found — run seed first");
    process.exit(1);
  }
  console.log(`Found rider: ${riderUser.displayName} (${riderUser._id})`);

  // ── 2. Update RiderProfile ──────────────────────────────────────────────
  const riderProfile = await RiderProfile.findOneAndUpdate(
    { user: riderUser._id },
    {
      isAvailable: true,          // online → dispatch considers this rider
      isVerified: true,           // verified → can accept deliveries
      currentLocation: RIDER_LOCATION, // ~1.5 km from test station
      vehicleType: "motorcycle",
      vehiclePlate: "LSD-123GZ",
      rating: 4.8,
      totalDeliveries: 47,
      bankAccount: {
        bankName: "Access Bank",
        accountNumber: "0123456789",
        accountName: "Test Rider",
      },
    },
    { new: true, upsert: true }
  );

  console.log(`\nRiderProfile updated:`);
  console.log(`  isAvailable    : ${riderProfile?.isAvailable}`);
  console.log(`  isVerified     : ${riderProfile?.isVerified}`);
  console.log(`  currentLocation: lat ${riderProfile?.currentLocation?.lat}, lng ${riderProfile?.currentLocation?.lng}`);
  console.log(`  vehiclePlate   : ${riderProfile?.vehiclePlate}`);

  // ── 3. Update test station — enable auto-accept ─────────────────────────
  const vendorUser = await User.findOne({ email: "vendor@gaznger.com" }).lean();
  if (!vendorUser) {
    console.warn("vendor@gaznger.com not found — skipping station update");
  } else {
    const station = await GasStation.findOneAndUpdate(
      { vendorId: vendorUser._id },
      {
        autoAcceptOrders: true,  // orders confirm instantly, no vendor action needed
        isActive: true,
      },
      { new: true }
    );

    if (station) {
      console.log(`\nStation updated:`);
      console.log(`  name            : ${station.name}`);
      console.log(`  autoAcceptOrders: ${station.autoAcceptOrders}`);
      console.log(`  isActive        : ${station.isActive}`);
      console.log(`  location        : lat ${station.location.lat}, lng ${station.location.lng}`);

      // Distance check
      const dlat = RIDER_LOCATION.lat - station.location.lat;
      const dlng = RIDER_LOCATION.lng - station.location.lng;
      const distKm = Math.sqrt(
        Math.pow(dlat * 111, 2) +
        Math.pow(dlng * 111 * Math.cos((station.location.lat * Math.PI) / 180), 2)
      );
      console.log(`\n  Rider distance from station: ~${distKm.toFixed(2)} km`);
      console.log(`  Dispatch radius (default)  : 10 km`);
      console.log(`  Will be dispatched?        : ${distKm <= 10 ? "YES ✓" : "NO ✗"}`);
    }
  }

  console.log("\n────────────────────────────────────────────────");
  console.log("Order flow test checklist:");
  console.log("  1. Login as customer@gaznger.com");
  console.log("  2. Place an order (Gaznger Test Station)");
  console.log("     → Auto-confirms immediately (autoAcceptOrders: true)");
  console.log("     → Dispatch runs within 1 minute");
  console.log("  3. Login as rider@gaznger.com");
  console.log("     → Dispatch offer appears on Queue screen via socket");
  console.log("     → Accept → Confirm Pickup → Mark Delivered");
  console.log("────────────────────────────────────────────────\n");

  await mongoose.disconnect();
  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
