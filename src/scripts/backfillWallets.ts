/**
 * Wallet Backfill Script
 *
 * One-shot migration to seed the new ledger from existing Earning + User
 * data. Idempotent — re-running it does NOT double-credit because each
 * synthetic Transaction is keyed by `idempotencyKey = "backfill:earning:<id>"`.
 *
 * What it does:
 *   1. Creates the two system wallets (platform-escrow, platform-revenue)
 *      if absent.
 *   2. Creates a Wallet for every existing User if absent.
 *   3. For each settled Earning, credits the user's wallet.available with
 *      a synthetic Transaction (one per earning). Pending earnings stay
 *      where they are — the new flow takes over from "settle" onward.
 *   4. Initializes the PlatformConfig singleton with schema defaults.
 *
 * Run: npx ts-node src/scripts/backfillWallets.ts
 *
 * Pre-launch DB is mostly empty so this is fast; the script also doubles
 * as the canonical "set up new fresh DB" routine.
 */

import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
import mongoose from "mongoose";

import User from "../models/User";
import Earning from "../models/Earning";
import Wallet from "../models/Wallet";
import PlatformConfig from "../models/PlatformConfig";
import {
  getOrCreateSystemWallet,
  getOrCreateUserWallet,
  postSingle,
} from "../utils/wallet";

const MONGO_URI = process.env.MONGO_URI!;

async function run() {
  console.log("🔌 Connecting to MongoDB…");
  await mongoose.connect(MONGO_URI);

  console.log("🏛  Ensuring PlatformConfig singleton…");
  const cfg = await PlatformConfig.findOne({ key: "main" });
  if (!cfg) {
    await PlatformConfig.create({ key: "main" });
    console.log("   created with defaults");
  } else {
    console.log("   already present");
  }

  console.log("🏦 Ensuring system wallets…");
  await getOrCreateSystemWallet("platform-escrow");
  await getOrCreateSystemWallet("platform-revenue");
  console.log("   ok");

  console.log("👥 Ensuring user wallets…");
  const users = await User.find({}).select("_id role").lean();
  for (const u of users) {
    await getOrCreateUserWallet(u._id);
  }
  console.log(`   ${users.length} users covered`);

  console.log("💰 Backfilling settled earnings → wallet.available…");
  const earnings = await Earning.find({ status: "settled" }).lean();
  let credited = 0;
  let skipped = 0;

  for (const e of earnings) {
    const wallet = await getOrCreateUserWallet(e.user);
    const idempotencyKey = `backfill:earning:${e._id}`;

    // Single-leg credit (we don't backfill the corresponding escrow debit
    // because pre-existing orders don't have a matching escrow row).
    const tx = await postSingle({
      wallet,
      amount: e.amount,
      state: "available",
      kind: e.role === "vendor" ? "vendor_earning_credit" : "rider_earning_credit",
      opts: {
        idempotencyKey,
        description: `Backfill: ${e.type === "fuel_sale" ? "fuel sale" : "delivery fee"} earning`,
        order: e.order,
        delivery: e.delivery,
        meta: { backfill: true, originalEarningId: e._id, originalSettledAt: e.settledAt },
      },
    });

    // Idempotency hit returns the existing row → its amount may differ in edge cases.
    if (tx.amount === e.amount && tx.meta && (tx.meta as any).backfill) {
      credited++;
    } else {
      skipped++;
    }
  }

  console.log(`   ${credited} credited, ${skipped} skipped (already backfilled)`);

  // Sanity print: aggregate wallet totals.
  const totals = await Wallet.aggregate([
    { $match: { ownerKind: "user" } },
    {
      $group: {
        _id: "$role",
        available: { $sum: "$available" },
        pending: { $sum: "$pending" },
        count: { $sum: 1 },
      },
    },
  ]);
  console.log("📊 Wallet totals by role:");
  for (const t of totals) {
    console.log(
      `   ${t._id ?? "?"}: ${t.count} wallets, available=${t.available}, pending=${t.pending}`
    );
  }

  await mongoose.disconnect();
  console.log("✅ Done");
}

run().catch((err) => {
  console.error("❌ Backfill failed:", err);
  process.exit(1);
});
