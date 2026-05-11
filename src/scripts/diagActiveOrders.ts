/**
 * Diagnose why a rider isn't seeing dispatch offers.
 *
 * Lists every order in a "should-be-actionable" state plus any pending
 * Delivery rows + the rider profile availability/location. Read-only.
 *
 * Run: npx ts-node src/scripts/diagActiveOrders.ts
 */

import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
import mongoose from "mongoose";
import Order from "../models/Order";
import Delivery from "../models/Delivery";
import RiderProfile from "../models/RiderProfile";
import GasStation from "../models/Station";
import User from "../models/User";

async function main() {
  await mongoose.connect(process.env.MONGO_URI!);
  const now = new Date();

  console.log(`\n=== diag @ ${now.toISOString()} ===\n`);

  const orders = await Order.find({
    status: { $in: ["pending", "confirmed", "assigned", "in-transit"] },
  })
    .sort({ createdAt: -1 })
    .limit(10)
    .lean();

  console.log(`-- ${orders.length} active order(s) --`);
  for (const o of orders) {
    const station = (await GasStation.findById(o.station).lean()) as
      | { name?: string; autoAcceptOrders?: boolean; location?: { lat: number; lng: number } }
      | null;
    const ageMin =
      (now.getTime() - new Date((o as any).createdAt).getTime()) / 60_000;
    console.log({
      _id: String(o._id),
      status: o.status,
      ageMin: Number(ageMin.toFixed(1)),
      stationName: station?.name,
      autoAcceptOrders: station?.autoAcceptOrders,
      stationCoords: station?.location,
      riderId: o.riderId ? String(o.riderId) : null,
      dispatchAttempt: (o as any).dispatchAttempt,
      dispatchExpiresAt: (o as any).dispatchExpiresAt,
    });
  }

  const pendingDeliveries = await Delivery.find({ status: "pending" })
    .sort({ createdAt: -1 })
    .limit(10)
    .lean();

  console.log(`\n-- ${pendingDeliveries.length} pending Delivery row(s) --`);
  for (const d of pendingDeliveries) {
    console.log({
      _id: String(d._id),
      order: String(d.order),
      rider: String(d.rider),
      status: d.status,
      riderEarnings: d.riderEarnings,
      createdAt: d.createdAt,
    });
  }

  const riders = await RiderProfile.find({}).lean();
  console.log(`\n-- ${riders.length} rider profile(s) --`);
  for (const r of riders) {
    const u = await User.findById(r.user).select("displayName email phone").lean();
    console.log({
      user: String(r.user),
      who: u
        ? { name: (u as any).displayName, email: (u as any).email, phone: (u as any).phone }
        : null,
      isAvailable: r.isAvailable,
      isVerified: (r as any).isVerified,
      hasLocation: !!(r.currentLocation?.lat && r.currentLocation?.lng),
      currentLocation: r.currentLocation,
    });
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
