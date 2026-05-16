/**
 * Reset script — cancels all in-flight orders + deliveries + bulk
 * purchases and flips every rider back to offline, so you can start a
 * clean test run.
 *
 * Run from /server:
 *   npx ts-node src/scripts/resetActiveOrders.ts
 *
 * Targets the DB in MONGO_URI from .env.local. Refuses to run against a
 * URI containing "prod" or "production" unless RESET_FORCE=1 is set.
 */
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import mongoose from "mongoose";
import Order from "../models/Order";
import Delivery from "../models/Delivery";
import FuelPlantOrder from "../models/FuelPlantOrder";
import RiderProfile from "../models/RiderProfile";

const TERMINAL_ORDER_STATUSES = [
  "delivered",
  "rated",
  "closed",
  "cancelled",
  "cancelled_by_customer",
  "cancelled_by_vendor",
  "cancelled_by_rider",
  "failed_payment",
];

const ACTIVE_DELIVERY_STATUSES = [
  "pending",
  "accepted",
  "picked_up",
  "at_plant",
  "refilling",
  "returning",
  "arrived",
  "dispensing",
  "awaiting_confirmation",
];

const ACTIVE_BULK_STATUSES = ["pending", "confirmed", "in-transit"];

async function run() {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI missing from .env.local");
  if (/prod|production/i.test(uri) && process.env.RESET_FORCE !== "1") {
    throw new Error(
      "Refusing to run against a prod URI without RESET_FORCE=1",
    );
  }

  await mongoose.connect(uri, { serverSelectionTimeoutMS: 8000 });
  console.log("Connected:", mongoose.connection.host);
  console.log("Database:", mongoose.connection.name);

  // 1. Customer orders
  const orders = await Order.updateMany(
    { status: { $nin: TERMINAL_ORDER_STATUSES } },
    {
      $set: {
        status: "cancelled",
        cancellationReason: "Manual reset via dev script",
        riderId: null,
        riderAssignedAt: null,
        dispatchExpiresAt: null,
      },
    },
  );

  // 2. Deliveries (rider's mirror of an order)
  const deliveries = await Delivery.updateMany(
    { status: { $in: ACTIVE_DELIVERY_STATUSES } },
    { $set: { status: "failed", dropReason: "Manual reset via dev script" } },
  );

  // 3. Vendor bulk purchases (FuelPlantOrder)
  const bulk = await FuelPlantOrder.updateMany(
    { status: { $in: ACTIVE_BULK_STATUSES } },
    {
      $set: {
        status: "cancelled",
        cancellationReason: "Manual reset via dev script",
      },
    },
  );

  // 4. Riders — flip every rider profile back to offline
  const riders = await RiderProfile.updateMany(
    { isAvailable: true },
    { $set: { isAvailable: false } },
  );

  console.log("");
  console.log("=== Reset summary ===");
  console.log(`  Customer orders cancelled : ${orders.modifiedCount}`);
  console.log(`  Deliveries failed         : ${deliveries.modifiedCount}`);
  console.log(`  Bulk purchases cancelled  : ${bulk.modifiedCount}`);
  console.log(`  Riders set offline        : ${riders.modifiedCount}`);

  await mongoose.disconnect();
  console.log("Done.");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
