/**
 * One-shot seed: add 2 additional Station rows for Abkon Oil (Aba +
 * Uyo) so we can test the multi-station carousel on Vendor Today.
 * The existing Ikot Ekpene station is preserved.
 *
 * Run: npx ts-node src/scripts/seedAbkonStations.ts
 */
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import mongoose from "mongoose";
import User from "../models/User";
import GasStation from "../models/Station";

// Approximate city centres. The Station model uses { lat, lng } (not
// GeoJSON), so we pass those directly.
const NEW_STATIONS = [
  {
    name: "Abkon Oil — Aba",
    state: "Abia",
    lga: "Aba South",
    address: "5 Asa Road, Aba",
    location: { lat: 5.1066, lng: 7.3667 },
  },
  {
    name: "Abkon Oil — Uyo",
    state: "Akwa Ibom",
    lga: "Uyo",
    address: "21 Aka Road, Uyo",
    location: { lat: 5.0377, lng: 7.9189 },
  },
];

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

  // Locate Abkon Oil. User model only has displayName/email — match on
  // those plus the role gate.
  const vendor = (await User.findOne({
    role: "vendor",
    $or: [{ displayName: /abkon/i }, { email: /abkon/i }],
  }).lean()) as any;

  if (!vendor) {
    throw new Error("No vendor named Abkon Oil found");
  }
  console.log(`Vendor: ${vendor.displayName} (${vendor._id})`);

  // Existing stations — used for dup-detection + as a config template.
  const existing = (await GasStation.find({ vendorId: vendor._id })
    .lean()) as any[];
  console.log(
    `Existing stations (${existing.length}): ${existing
      .map((s) => `${s.name} [${s.lga ?? "?"}]`)
      .join(", ")}`,
  );

  const template = existing[0];
  if (!template) {
    throw new Error("Existing template station not found");
  }

  const created: string[] = [];
  for (const def of NEW_STATIONS) {
    const dup = existing.find(
      (s) => s.name?.toLowerCase() === def.name.toLowerCase(),
    );
    if (dup) {
      console.log(`  SKIP ${def.name} — already exists`);
      continue;
    }
    const doc = (await GasStation.create({
      vendorId: vendor._id,
      name: def.name,
      address: def.address,
      state: def.state,
      lga: def.lga,
      location: def.location,
      // Mirror template config so the station is usable immediately.
      isActive: true,
      autoAcceptOrders: template.autoAcceptOrders ?? false,
      operatingHours: template.operatingHours,
      paymentOptions: template.paymentOptions ?? [],
      fuels: template.fuels ?? [],
      verified: template.verified ?? false,
    })) as any;
    created.push(`${doc.name} (${doc._id})`);
  }

  console.log("");
  console.log("=== Seed summary ===");
  for (const c of created) console.log(`  + ${c}`);
  if (created.length === 0) console.log("  (no new stations created)");

  await mongoose.disconnect();
  console.log("Done.");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
