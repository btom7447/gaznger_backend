/**
 * Reconcile Order.status ↔ Delivery.status drift.
 *
 * Phase 5 of the execution plan. Audits every in-flight order
 * (status in ACTIVE_ORDER_STATUSES) and reports / fixes pairs where
 * Order.status and Delivery.status disagree.
 *
 * The two enums coexist by design (legacy + v3 granular pipelines),
 * but they should always be writing the same value via
 * `applyRiderTransition`. Drift only happens if:
 *   - One write succeeded and the other failed (no transaction).
 *   - A manual admin tweak touched only one side.
 *   - Pre-Phase-1 code paths existed where the values diverged.
 *
 * Usage:
 *   npm run reconcile:status            -- dry-run (default)
 *   npm run reconcile:status -- --apply -- actually writes the fix
 *
 * Resolution policy:
 *   - Order.status is canonical (customer reads it).
 *   - Delivery.status is reset to match Order.status when they
 *     differ. Exception: terminal Delivery states (delivered,
 *     dropped, failed) are NOT overwritten — those carry
 *     non-redundant operational meaning (drop reason, customer
 *     confirmed at, etc.) we don't want to lose. We only flag
 *     them for manual review.
 */

import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
dotenv.config(); // fall back to .env if .env.local missing
import mongoose from "mongoose";
import Order from "../models/Order";
import Delivery from "../models/Delivery";
import { ACTIVE_ORDER_STATUSES } from "../_shared";

const APPLY = process.argv.includes("--apply");

interface DriftReport {
  orderId: string;
  deliveryId?: string;
  orderStatus: string;
  deliveryStatus: string | "(no delivery)";
  resolution: "fix" | "manual-review" | "skip";
}

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error("✗ MONGO_URI not set — aborting.");
    process.exit(1);
  }

  await mongoose.connect(uri);
  console.log(`reconcile:status — ${APPLY ? "APPLY mode" : "DRY-RUN"}`);

  const orders = await Order.find({
    status: { $in: ACTIVE_ORDER_STATUSES as unknown as string[] },
  })
    .select("_id status riderId")
    .lean();

  console.log(`scanning ${orders.length} active orders…`);

  const drifts: DriftReport[] = [];
  const TERMINAL_DELIVERY_STATES = new Set([
    "delivered",
    "dropped",
    "failed",
  ]);

  for (const order of orders) {
    // No rider yet — Delivery may not exist; that's expected for
    // pending/confirmed/assigning. Skip.
    if (!order.riderId) continue;

    const delivery = await Delivery.findOne({ order: order._id })
      .select("_id status")
      .sort({ createdAt: -1 })
      .lean();

    if (!delivery) {
      drifts.push({
        orderId: String(order._id),
        orderStatus: order.status,
        deliveryStatus: "(no delivery)",
        resolution: "manual-review",
      });
      continue;
    }

    if (delivery.status === order.status) continue;

    // Special case: many active Order statuses correspond to one
    // Delivery status. We only flag drift for granular states where
    // they should be identical. Comparing as `string` here because
    // Mongoose's `.lean()` typing is narrow but the actual values
    // can include legacy strings.
    const oStr: string = order.status as unknown as string;
    const dStr: string = delivery.status as unknown as string;
    const sameMeaning =
      (oStr === "in-transit" && dStr === "picked_up") ||
      (oStr === "in_transit" && dStr === "picked_up") ||
      (oStr === "assigned" && dStr === "accepted");
    if (sameMeaning) continue;

    if (TERMINAL_DELIVERY_STATES.has(delivery.status)) {
      drifts.push({
        orderId: String(order._id),
        deliveryId: String(delivery._id),
        orderStatus: order.status,
        deliveryStatus: delivery.status,
        resolution: "manual-review",
      });
      continue;
    }

    drifts.push({
      orderId: String(order._id),
      deliveryId: String(delivery._id),
      orderStatus: order.status,
      deliveryStatus: delivery.status,
      resolution: "fix",
    });
  }

  // Report.
  console.log();
  console.log(`drift summary:`);
  console.log(`  total scanned:  ${orders.length}`);
  console.log(`  drifts found:   ${drifts.length}`);
  console.log(`    auto-fix:     ${drifts.filter((d) => d.resolution === "fix").length}`);
  console.log(`    manual-review:${drifts.filter((d) => d.resolution === "manual-review").length}`);

  if (drifts.length > 0) {
    console.log();
    console.log(`drift details:`);
    for (const d of drifts) {
      console.log(
        `  ${d.resolution.padEnd(14)} order=${d.orderId} ` +
          `o.status=${d.orderStatus} d.status=${d.deliveryStatus}`
      );
    }
  }

  if (!APPLY) {
    console.log();
    console.log("(dry-run) re-run with --apply to write fixes.");
    await mongoose.disconnect();
    return;
  }

  let applied = 0;
  for (const d of drifts) {
    if (d.resolution !== "fix" || !d.deliveryId) continue;
    await Delivery.updateOne(
      { _id: d.deliveryId },
      { status: d.orderStatus }
    );
    applied++;
  }
  console.log();
  console.log(`applied ${applied} fixes.`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("✗ reconcile:status failed:", err);
  process.exit(1);
});
