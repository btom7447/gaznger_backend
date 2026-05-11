/**
 * Create a delivery address in the customer's address book at the
 * rider's current location, so dispatch finds the rider in-radius.
 *
 * Usage: npx ts-node src/scripts/addAddressNearRider.ts [customerEmail]
 *
 * If no email is passed, uses the most recent active order's owner.
 */

import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
import mongoose from "mongoose";
import RiderProfile from "../models/RiderProfile";
import Address from "../models/Address";
import User from "../models/User";
import Order from "../models/Order";

async function main() {
  await mongoose.connect(process.env.MONGO_URI!);

  // 1. Pick the rider — only one in this dev DB, but keep it explicit.
  const rider = await RiderProfile.findOne({ isAvailable: true })
    .sort({ updatedAt: -1 })
    .lean();
  if (!rider?.currentLocation?.lat || !rider?.currentLocation?.lng) {
    console.error("No available rider with a current location");
    process.exit(1);
  }
  const { lat, lng } = rider.currentLocation;

  // 2. Pick the customer.
  const emailArg = process.argv[2];
  let customerId: mongoose.Types.ObjectId | null = null;

  if (emailArg) {
    const u = await User.findOne({ email: emailArg }).select("_id").lean();
    if (!u) {
      console.error(`No user with email ${emailArg}`);
      process.exit(1);
    }
    customerId = u._id as mongoose.Types.ObjectId;
  } else {
    const recent = await Order.findOne({})
      .sort({ createdAt: -1 })
      .select("user")
      .lean();
    if (!recent) {
      console.error("No orders found and no email passed");
      process.exit(1);
    }
    customerId = recent.user as mongoose.Types.ObjectId;
  }

  const customer = await User.findById(customerId)
    .select("displayName email phone")
    .lean();

  // 3. Avoid duplicate label.
  const label = "Near rider (dev)";
  await Address.deleteMany({ user: customerId, label });

  const address = await Address.create({
    user: customerId,
    label,
    street: "Rider current GPS",
    city: "Dev",
    state: "Dev",
    country: "Nigeria",
    icon: "location-outline",
    latitude: lat,
    longitude: lng,
  });

  console.log("\n✅ Address created\n");
  console.log({
    customer: {
      id: String(customerId),
      name: (customer as any)?.displayName,
      email: (customer as any)?.email,
      phone: (customer as any)?.phone,
    },
    address: {
      id: String(address._id),
      label: address.label,
      lat,
      lng,
    },
    nextSteps: [
      "Open the customer app",
      "Place a new order using the 'Near rider (dev)' address",
      "The rider is 0 km away → dispatch will fire on the next cron tick (≤60s)",
    ],
  });

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
