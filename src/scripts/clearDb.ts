/**
 * Clear all collections for a clean test environment.
 * Run: npx ts-node src/scripts/clearDb.ts
 * Then: npx ts-node src/scripts/seed.ts
 */
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
import mongoose from "mongoose";

const COLLECTIONS = [
  "users",
  "addresses",
  "fueltypes",
  "gasstations",
  "riderprofiles",
  "orders",
  "deliveries",
  "ratings",
  "points",
  "wallets",
  "transactions",
  "earnings",
  "notifications",
  "refreshtokens",
  "auditlogs",
  "disputes",
  "webhookevents",
  "withdrawals",
  "fuelplantorders",
  "platformconfigs",
];

async function run() {
  await mongoose.connect(process.env.MONGO_URI!, { serverSelectionTimeoutMS: 8000 });
  console.log("Connected:", mongoose.connection.host);

  const db = mongoose.connection.db!;
  const existing = (await db.listCollections().toArray()).map((c) => c.name);

  for (const name of COLLECTIONS) {
    if (existing.includes(name)) {
      await db.collection(name).deleteMany({});
      console.log(`  cleared: ${name}`);
    } else {
      console.log(`  skipped (not found): ${name}`);
    }
  }

  await mongoose.disconnect();
  console.log("\nDone. Run: npx ts-node src/scripts/seed.ts");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
