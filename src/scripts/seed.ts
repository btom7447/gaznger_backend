/**
 * DB Seed Script
 * Creates 4 test accounts (customer, vendor, rider, admin) + fuel types + station + rider profile.
 * Run: npx ts-node src/scripts/seed.ts
 * All passwords: Password@123
 */

import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
import mongoose from "mongoose";
import bcrypt from "bcrypt";

// Models
import User from "../models/User";
import FuelType from "../models/FuelType";
import GasStation from "../models/Station";
import RiderProfile from "../models/RiderProfile";
import Address from "../models/Address";

const MONGO_URI = process.env.MONGO_URI!;
const PASSWORD = "Password@123";
const SALT_ROUNDS = 10;

async function seed() {
  console.log("🌱 Connecting to MongoDB…");
  await mongoose.connect(MONGO_URI);
  console.log("✅ Connected\n");

  const hash = await bcrypt.hash(PASSWORD, SALT_ROUNDS);

  // ─── Fuel Types ──────────────────────────────────────────────────────────
  console.log("⛽ Seeding fuel types…");
  const fuels = await Promise.all([
    FuelType.findOneAndUpdate(
      { name: "Petrol" },
      { $set: { name: "Petrol", unit: "L" }, $unset: { pricePerUnit: "" } },
      { upsert: true, new: true }
    ),
    FuelType.findOneAndUpdate(
      { name: "Diesel" },
      { $set: { name: "Diesel", unit: "L" }, $unset: { pricePerUnit: "" } },
      { upsert: true, new: true }
    ),
    FuelType.findOneAndUpdate(
      { name: "Gas" },
      { $set: { name: "Gas", unit: "kg" }, $unset: { pricePerUnit: "" } },
      { upsert: true, new: true }
    ),
    FuelType.findOneAndUpdate(
      { name: "Oil" },
      { $set: { name: "Oil", unit: "L" }, $unset: { pricePerUnit: "" } },
      { upsert: true, new: true }
    ),
  ]);
  const [petrol, diesel, gas, oil] = fuels;
  console.log(`   Petrol (L)  |  Diesel (L)  |  Gas (kg)  |  Oil (L)`);

  // ─── Users ───────────────────────────────────────────────────────────────
  console.log("\n👤 Seeding users…");

  const maleAvatar = "https://avatar.iran.liara.run/public/19";

  const customerData = {
    email: "customer@gaznger.com",
    phone: "08012345678",
    passwordHash: hash,
    displayName: "Test Customer",
    gender: "male" as const,
    profileImage: maleAvatar,
    role: "customer" as const,
    isOnboarded: true,
    isVerified: true,
    points: 250,
  };

  const vendorData = {
    email: "vendor@gaznger.com",
    phone: "08023456789",
    passwordHash: hash,
    displayName: "Test Vendor",
    gender: "male" as const,
    profileImage: maleAvatar,
    role: "vendor" as const,
    isOnboarded: true,
    isVerified: true,
    vendorVerification: { status: "verified", submittedAt: new Date() },
    partnerBadge: { plan: "standard", active: true, subscribedAt: new Date() },
  };

  const riderData = {
    email: "rider@gaznger.com",
    phone: "08034567890",
    passwordHash: hash,
    displayName: "Test Rider",
    gender: "male" as const,
    profileImage: maleAvatar,
    role: "rider" as const,
    isOnboarded: true,
    isVerified: true,
  };

  const adminData = {
    email: "admin@gaznger.com",
    phone: "08045678901",
    passwordHash: hash,
    displayName: "Super Admin",
    gender: "male" as const,
    profileImage: maleAvatar,
    role: "admin" as const,
    isOnboarded: true,
    isVerified: true,
  };

  async function upsertUser(data: Record<string, any>) {
    const existing = await User.findOne({ email: data.email });
    if (existing) {
      return User.findByIdAndUpdate(existing._id, { $set: data }, { new: true }) as Promise<typeof existing>;
    }
    return User.create(data);
  }

  const [customer, vendor, rider, admin] = await Promise.all([
    upsertUser(customerData),
    upsertUser(vendorData),
    upsertUser(riderData),
    upsertUser(adminData),
  ]);

  console.log(`   ✓ customer@gaznger.com  (role: customer)`);
  console.log(`   ✓ vendor@gaznger.com    (role: vendor)`);
  console.log(`   ✓ rider@gaznger.com     (role: rider)`);
  console.log(`   ✓ admin@gaznger.com     (role: admin)`);

  // ─── Customer default address ─────────────────────────────────────────────
  console.log("\n📍 Seeding customer address…");
  const address = await Address.findOneAndUpdate(
    { user: customer._id, label: "Home" },
    {
      user: customer._id,
      label: "Home",
      street: "14 Udo Udoma Avenue",
      city: "Ikot Ekpene",
      state: "Akwa Ibom",
      country: "Nigeria",
      postalCode: "532101",
      icon: "home-outline",
      latitude: 5.1920,
      longitude: 7.7230,
    },
    { upsert: true, new: true }
  );
  await User.findByIdAndUpdate(customer._id, {
    defaultAddress: address._id,
    $addToSet: { addressBook: address._id },
  });
  console.log(`   ✓ 14 Udo Udoma Avenue, Ikot Ekpene, Akwa Ibom`);

  // ─── Gas Station (linked to vendor) ──────────────────────────────────────
  console.log("\n🏪 Seeding gas station…");
  const station = await GasStation.findOneAndUpdate(
    { vendorId: vendor._id },
    {
      name: "Gaznger Test Station",
      address: "15 Ikot Ekpene Road",
      state: "Akwa Ibom",
      lga: "Ikot Ekpene",
      location: { lat: 5.1750, lng: 7.7100 },
      fuels: [
        { fuel: petrol._id, pricePerUnit: 897, available: true },
        { fuel: diesel._id, pricePerUnit: 1300, available: true },
        { fuel: gas._id, pricePerUnit: 1600, available: true },
        { fuel: oil._id, pricePerUnit: 1200, available: true },
      ],
      rating: 4.5,
      image: "https://images.unsplash.com/photo-1545984412-4b8e3b0e4e9e?w=400",
      verified: true,
      vendorId: vendor._id,
      isActive: true,
      autoAcceptOrders: true,
      operatingHours: { open: "06:00", close: "22:00" },
    },
    { upsert: true, new: true }
  );
  console.log(`   ✓ ${station.name} — 15 Ikot Ekpene Rd, Akwa Ibom`);

  // ─── Rider Profile ────────────────────────────────────────────────────────
  console.log("\n🏍️  Seeding rider profile…");
  await RiderProfile.findOneAndUpdate(
    { user: rider._id },
    {
      user: rider._id,
      vehicleType: "motorcycle",
      vehiclePlate: "LSD-123GZ",
      isAvailable: true,
      isVerified: true,
      // All three test points in Ikot Ekpene, Akwa Ibom — within ~3 km of each other
      // Station: 5.1750, 7.7100 | Customer home: 5.1920, 7.7230 | Rider: 5.1833, 7.7167
      currentLocation: { lat: 5.1833, lng: 7.7167 },
      rating: 4.8,
      totalDeliveries: 47,
      bankAccount: {
        bankName: "Access Bank",
        accountNumber: "0123456789",
        accountName: "Test Rider",
      },
    },
    { upsert: true, new: true }
  );
  console.log(`   ✓ motorcycle · LSD-123GZ · 47 deliveries`);

  // ─── Summary ─────────────────────────────────────────────────────────────
  console.log("\n─────────────────────────────────────────────");
  console.log("🎉 Seed complete! Test credentials:");
  console.log("");
  console.log("  Role       Email                    Password");
  console.log("  ─────────  ───────────────────────  ─────────────");
  console.log("  Customer   customer@gaznger.com      Password@123");
  console.log("  Vendor     vendor@gaznger.com        Password@123");
  console.log("  Rider      rider@gaznger.com         Password@123");
  console.log("  Admin      admin@gaznger.com         Password@123");
  console.log("─────────────────────────────────────────────\n");

  await mongoose.disconnect();
  process.exit(0);
}

seed().catch((err) => {
  console.error("❌ Seed failed:", err);
  mongoose.disconnect();
  process.exit(1);
});
