/**
 * Earnings Cleanup Script
 * Deletes ALL earning records so the DB starts fresh with the correct
 * pending → settled lifecycle (pending on confirm, settled on delivery).
 *
 * Run: npx ts-node src/scripts/clearEarnings.ts
 */

import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
import mongoose from "mongoose";
import Earning from "../models/Earning";

async function main() {
  await mongoose.connect(process.env.MONGO_URI!);
  console.log("Connected to MongoDB");

  const result = await Earning.deleteMany({});
  console.log(`Deleted ${result.deletedCount} earning record(s).`);

  await mongoose.disconnect();
  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
