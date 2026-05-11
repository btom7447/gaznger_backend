/**
 * DB Seed Script — v4 phone-first auth.
 *
 * Wipes the non-admin users, their addresses + station + rider profile,
 * then re-seeds three named test accounts (customer, vendor, rider) +
 * one admin. PIN is 1234 across the board for E2E QA.
 *
 * Phones are stored in E.164. The customer/rider local-format numbers
 * (091…, 080…) get the +234 prefix automatically below.
 *
 * Run: npx ts-node src/scripts/seed.ts
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
const PIN = "1234";
const SALT_ROUNDS = 10;

/**
 * Convert a local Nigerian number ("09155674236" / "08083499466") to
 * E.164 ("+2349155674236"). Strips any leading 0 then prefixes +234.
 * Numbers already in E.164 pass through unchanged.
 */
function toE164(local: string): string {
  if (local.startsWith("+")) return local;
  return `+234${local.replace(/^0+/, "").replace(/\D/g, "")}`;
}

async function seed() {
  console.log("🌱 Connecting to MongoDB…");
  await mongoose.connect(MONGO_URI);
  console.log("✅ Connected\n");

  // ─── Wipe non-admin users + their satellite docs ─────────────────────────
  // We deliberately keep admin records so anyone with the admin token can
  // still log in after a re-seed without burning a verifyOtp round-trip.
  // Order matters: child docs first, then the user docs themselves.
  console.log("🧹 Clearing previous customer/vendor/rider records…");
  const oldUsers = await User.find({ role: { $in: ["customer", "vendor", "rider"] } })
    .select("_id")
    .lean();
  const oldIds = oldUsers.map((u) => u._id);
  if (oldIds.length) {
    await Promise.all([
      Address.deleteMany({ user: { $in: oldIds } }),
      GasStation.deleteMany({ vendorId: { $in: oldIds } }),
      RiderProfile.deleteMany({ user: { $in: oldIds } }),
    ]);
    await User.deleteMany({ _id: { $in: oldIds } });
    console.log(`   ✓ removed ${oldIds.length} non-admin user(s) + satellites`);
  } else {
    console.log("   ✓ nothing to clear");
  }

  const hash = await bcrypt.hash(PASSWORD, SALT_ROUNDS);
  const pinHash = await bcrypt.hash(PIN, SALT_ROUNDS);

  // ─── Fuel Types ──────────────────────────────────────────────────────────
  console.log("\n⛽ Seeding fuel types…");
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
    email: "benjamin.tom@gaznger.com",
    phone: toE164("09155674236"),
    phoneVerified: true,
    passwordHash: hash,
    pinHash,
    displayName: "Benjamin Tom",
    gender: "male" as const,
    profileImage: maleAvatar,
    role: "customer" as const,
    isOnboarded: true,
    isVerified: true,
    accountStatus: "active" as const,
    points: 250,
  };

  const vendorData = {
    email: "abkon.oil@gaznger.com",
    phone: toE164("08083499466"),
    phoneVerified: true,
    passwordHash: hash,
    pinHash,
    displayName: "Abkon Oil Ltd",
    gender: "male" as const,
    profileImage: maleAvatar,
    role: "vendor" as const,
    isOnboarded: true,
    isVerified: true,
    accountStatus: "active" as const,
    verificationStatus: "approved" as const,
    vendorVerification: { status: "verified", submittedAt: new Date() },
    partnerBadge: { plan: "standard", active: true, subscribedAt: new Date() },
  };

  const riderData = {
    email: "ekemini.tom@gaznger.com",
    phone: toE164("09134876624"),
    phoneVerified: true,
    passwordHash: hash,
    pinHash,
    displayName: "Ekemini Tom",
    gender: "male" as const,
    profileImage: maleAvatar,
    role: "rider" as const,
    isOnboarded: true,
    isVerified: true,
    accountStatus: "active" as const,
    verificationStatus: "approved" as const,
  };

  const adminData = {
    email: "admin@gaznger.com",
    phone: "+2348045678901",
    phoneVerified: true,
    passwordHash: hash,
    pinHash,
    displayName: "Super Admin",
    gender: "male" as const,
    profileImage: maleAvatar,
    role: "admin" as const,
    isOnboarded: true,
    isVerified: true,
    accountStatus: "active" as const,
  };

  /** Upsert by phone (primary identity) so a re-seed without the wipe
   *  block above doesn't insert duplicates. The wipe runs ahead of this
   *  for non-admin roles; admin always upserts. */
  async function upsertUser(data: Record<string, any>) {
    const existing = await User.findOne({
      $or: [{ phone: data.phone }, { email: data.email }],
    });
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

  console.log(`   ✓ Benjamin Tom    (customer · ${customerData.phone})`);
  console.log(`   ✓ Abkon Oil Ltd   (vendor   · ${vendorData.phone})`);
  console.log(`   ✓ Ekemini Tom     (rider    · ${riderData.phone})`);
  console.log(`   ✓ Super Admin     (admin    · ${adminData.phone})`);

  // ─── Customer default address ─────────────────────────────────────────────
  // Same address as the previous customer@gaznger.com seed so QA scripts
  // that key on the lat/lng (5.1920, 7.7230) keep working.
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

  // ─── Gas Stations ────────────────────────────────────────────────────────
  // Five stations scattered around the customer's home (5.1920, 7.7230)
  // at varying distances + price/rating spreads. The mix is deliberate
  // so the Cheapest/Nearest/Top-rated sort chips each surface a
  // different leader, and the 5km vs 10km radius logic actually toggles
  // a non-trivial subset (Conoil at ~6.4km drops out of "nearest").
  //
  // Only Abkon is linked to a vendor (the seeded `vendor` user) so it's
  // the single Gaznger Partner station. The rest are listed-only — they
  // exercise the non-partner trust banner + the auto-pick fall-back
  // when the partner pool is too small to score against.
  console.log("\n🏪 Seeding stations…");

  // Common amenity payload every seeded station gets so the "What's
  // there" section in the detail sheet has something to render. Each
  // station overrides the bits that should differ (service time +
  // last dispense in particular).
  const COMMON_PAYMENT_OPTIONS = ["Card & POS", "Bank transfer", "USSD"];

  // Wipe any stations from previous seeds (the standalone ones don't
  // belong to a vendor, so the earlier wipe block missed them).
  await GasStation.deleteMany({ vendorId: { $exists: false } });

  // Helper: minutes-ago timestamp for the lastDispenseAt seeds. Keeps
  // each station's "Last dispense" line distinct so the relative
  // formatter actually has different inputs to format.
  const minsAgo = (m: number) => new Date(Date.now() - m * 60_000);

  type SeedStation = {
    name: string;
    address: string;
    location: { lat: number; lng: number };
    rating: number;
    petrol: number;
    diesel: number;
    gas: number;
    oil: number;
    image: string;
    verified: boolean;
    vendorId?: typeof vendor._id;
    serviceTime: string;
    paymentOptions: string[];
    lastDispenseAt: Date;
    onTimeRate?: number;
    operatingHours: { open: string; close: string };
  };

  const stationSeeds: SeedStation[] = [
    {
      name: "Abkon Oil Ltd",
      address: "15 Ikot Ekpene Road",
      location: { lat: 5.1750, lng: 7.7100 }, // ~2.4 km SW of home
      rating: 4.5,
      petrol: 897, diesel: 1300, gas: 1600, oil: 1200,
      image: "https://images.unsplash.com/photo-1545984412-4b8e3b0e4e9e?w=400",
      verified: true,
      vendorId: vendor._id, // Partner — only one with a vendor link
      serviceTime: "~12 min from accept",
      paymentOptions: COMMON_PAYMENT_OPTIONS,
      lastDispenseAt: minsAgo(15),
      onTimeRate: 96,
      operatingHours: { open: "06:00", close: "22:00" },
    },
    {
      name: "NNPC Ikot Ekpene",
      address: "Aba–Ikot Ekpene Road",
      location: { lat: 5.1950, lng: 7.7190 }, // ~0.6 km N
      rating: 4.7,
      petrol: 870, diesel: 1280, gas: 1580, oil: 1180,
      image: "https://images.unsplash.com/photo-1612066437-39ddc6ed3290?w=400",
      verified: true,
      serviceTime: "~8 min from accept",
      paymentOptions: COMMON_PAYMENT_OPTIONS,
      lastDispenseAt: minsAgo(4),
      onTimeRate: 91,
      operatingHours: { open: "00:00", close: "23:59" }, // 24/7
    },
    {
      name: "TotalEnergies Aba Road",
      address: "Plot 22 Aba Road, Ikot Ekpene",
      location: { lat: 5.1830, lng: 7.7370 }, // ~1.9 km SE
      rating: 4.9,
      petrol: 905, diesel: 1320, gas: 1620, oil: 1220,
      image: "https://images.unsplash.com/photo-1486006920555-c77dcf18193c?w=400",
      verified: true,
      serviceTime: "~14 min from accept",
      paymentOptions: COMMON_PAYMENT_OPTIONS,
      lastDispenseAt: minsAgo(22),
      onTimeRate: 98,
      operatingHours: { open: "05:30", close: "23:00" },
    },
    {
      name: "Mobil Express Forum Mall",
      address: "Forum Mall, Itam–Ikot Ekpene Rd",
      location: { lat: 5.2170, lng: 7.7020 }, // ~3.8 km NW
      rating: 4.2,
      petrol: 845, diesel: 1260, gas: 1560, oil: 1170,
      image: "https://images.unsplash.com/photo-1611573810861-9d3da6ef2d7f?w=400",
      verified: true,
      serviceTime: "~18 min from accept",
      paymentOptions: ["Card & POS", "Bank transfer"],
      lastDispenseAt: minsAgo(48),
      onTimeRate: 88,
      operatingHours: { open: "06:00", close: "21:30" },
    },
    {
      name: "Conoil Junction Plaza",
      address: "Junction Plaza, Uyo–Ikot Ekpene Hwy",
      location: { lat: 5.1500, lng: 7.7610 }, // ~6.4 km SE — outside 5km nearest cutoff
      rating: 4.0,
      petrol: 825, diesel: 1240, gas: 1540, oil: 1150,
      image: "https://images.unsplash.com/photo-1567103472667-6898f3a79cf2?w=400",
      verified: false, // Listed-only, exercises the non-verified path
      serviceTime: "~24 min from accept",
      paymentOptions: ["Card & POS", "USSD"],
      lastDispenseAt: minsAgo(125),
      // No onTimeRate set — exercises the "—" blank state in the stat tile
      operatingHours: { open: "07:00", close: "20:00" },
    },
  ];

  for (const seed of stationSeeds) {
    const filter = seed.vendorId
      ? { vendorId: seed.vendorId }
      : { name: seed.name, "location.lat": seed.location.lat };
    const doc = await GasStation.findOneAndUpdate(
      filter,
      {
        name: seed.name,
        address: seed.address,
        state: "Akwa Ibom",
        lga: "Ikot Ekpene",
        location: seed.location,
        fuels: [
          { fuel: petrol._id, pricePerUnit: seed.petrol, available: true },
          { fuel: diesel._id, pricePerUnit: seed.diesel, available: true },
          { fuel: gas._id, pricePerUnit: seed.gas, available: true },
          { fuel: oil._id, pricePerUnit: seed.oil, available: true },
        ],
        rating: seed.rating,
        image: seed.image,
        verified: seed.verified,
        ...(seed.vendorId ? { vendorId: seed.vendorId } : {}),
        isActive: true,
        autoAcceptOrders: true,
        operatingHours: seed.operatingHours,
        serviceTime: seed.serviceTime,
        paymentOptions: seed.paymentOptions,
        lastDispenseAt: seed.lastDispenseAt,
        ...(seed.onTimeRate != null ? { onTimeRate: seed.onTimeRate } : {}),
      },
      { upsert: true, new: true }
    );
    console.log(`   ✓ ${doc.name} — ${doc.address}`);
  }

  // ─── Rider Profile ────────────────────────────────────────────────────────
  // Rider home/idle position == previous rider seed's mid-Ikot-Ekpene
  // coordinate so the dispatcher's distance calc still works in tests.
  console.log("\n🏍️  Seeding rider profile…");
  await RiderProfile.findOneAndUpdate(
    { user: rider._id },
    {
      user: rider._id,
      vehicleType: "motorcycle",
      vehiclePlate: "LSD-456GZ",
      isAvailable: true,
      isVerified: true,
      // Station: 5.1750, 7.7100 | Customer home: 5.1920, 7.7230 | Rider: 5.1833, 7.7167
      currentLocation: { lat: 5.1833, lng: 7.7167 },
      rating: 4.8,
      totalDeliveries: 47,
      bankAccount: {
        bankName: "Access Bank",
        accountNumber: "0123456789",
        accountName: "Ekemini Tom",
      },
    },
    { upsert: true, new: true }
  );
  console.log(`   ✓ motorcycle · LSD-456GZ · 47 deliveries`);

  // ─── Summary ─────────────────────────────────────────────────────────────
  console.log("\n─────────────────────────────────────────────");
  console.log("🎉 Seed complete! Test credentials (PIN 1234):");
  console.log("");
  console.log("  Role       Name              Phone");
  console.log("  ─────────  ────────────────  ─────────────────");
  console.log(`  Customer   Benjamin Tom      ${customerData.phone}`);
  console.log(`  Vendor     Abkon Oil Ltd     ${vendorData.phone}`);
  console.log(`  Rider      Ekemini Tom       ${riderData.phone}`);
  console.log(`  Admin      Super Admin       ${adminData.phone}`);
  console.log("─────────────────────────────────────────────\n");

  await mongoose.disconnect();
  process.exit(0);
}

seed().catch((err) => {
  console.error("❌ Seed failed:", err);
  mongoose.disconnect();
  process.exit(1);
});
