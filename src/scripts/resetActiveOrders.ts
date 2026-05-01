/**
 * Reset script — cancels all in-flight orders + deliveries so you
 * can start a clean test run.
 *
 * Run: npx ts-node -e "require('./src/scripts/resetActiveOrders')"
 * Or:  npx ts-node src/scripts/resetActiveOrders.ts
 */
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import mongoose from "mongoose";
import Order from "../models/Order";
import Delivery from "../models/Delivery";

const ACTIVE_ORDER_STATUSES = [
  "pending_payment",
  "confirmed",
  "assigning",
  "assigned",
  "in-transit",
  "in_transit",
  "picked_up",
  "at_plant",
  "refilling",
  "returning",
  "arrived",
  "dispensing",
  "awaiting_confirmation",
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

async function run() {
  await mongoose.connect(process.env.MONGO_URI!, {
    serverSelectionTimeoutMS: 8000,
  });
  console.log("Connected:", mongoose.connection.host);

  const orders = await Order.updateMany(
    { status: { $in: ACTIVE_ORDER_STATUSES } },
    {
      $set: {
        status: "cancelled",
        cancellationReason: "Manual reset via dev script",
        riderId: null,
        riderAssignedAt: null,
        dispatchExpiresAt: null,
      },
    }
  );

  const deliveries = await Delivery.updateMany(
    { status: { $in: ACTIVE_DELIVERY_STATUSES } },
    { $set: { status: "failed", dropReason: "Manual reset via dev script" } }
  );

  console.log(`Orders cancelled: ${orders.modifiedCount}`);
  console.log(`Deliveries reset: ${deliveries.modifiedCount}`);

  await mongoose.disconnect();
  console.log("Done.");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
