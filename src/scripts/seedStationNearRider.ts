/**
 * Seed a Gaznger station near the rider's current GPS so the
 * dispatch radius gate passes for the new "Near rider (dev)"
 * delivery address.
 *
 * Station is offset ~1 km from the rider so distance > 0 (matches
 * the Lagos test seed pattern). Auto-accept on so the order flips
 * straight to `confirmed` and the dispatch cron picks it up next tick.
 *
 * Usage: npx ts-node src/scripts/seedStationNearRider.ts
 */

import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
import mongoose from "mongoose";
import RiderProfile from "../models/RiderProfile";
import GasStation from "../models/Station";
import FuelType from "../models/FuelType";

const STATION_NAME = "Gaznger Test Depot (near rider)";

async function main() {
  await mongoose.connect(process.env.MONGO_URI!);

  // 1. Rider GPS — same source as the address script.
  const rider = await RiderProfile.findOne({ isAvailable: true })
    .sort({ updatedAt: -1 })
    .lean();
  if (!rider?.currentLocation?.lat || !rider?.currentLocation?.lng) {
    console.error("No available rider with a current location");
    process.exit(1);
  }
  // Offset ~0.01° lat (~1.1 km) so the station isn't on top of the rider.
  const lat = rider.currentLocation.lat + 0.01;
  const lng = rider.currentLocation.lng;

  // 2. Pull every active fuel type so the station can sell all of them.
  const fuels = await FuelType.find({}).lean();
  if (fuels.length === 0) {
    console.error("No FuelType rows — run the seed script first");
    process.exit(1);
  }

  // Sensible per-fuel prices (NGN/litre or NGN/kg). Mirror the test
  // seed values rather than scraping live prices — this is a dev
  // convenience, not a market quote.
  const PRICE_BY_NAME: Record<string, number> = {
    petrol: 750,
    diesel: 1100,
    kerosene: 1200,
    kero: 1200,
    gas: 1500,
    lpg: 1500,
  };
  const fuelEntries = fuels.map((f) => {
    const key = (f as any).name?.toString().toLowerCase() ?? "";
    const price = PRICE_BY_NAME[key] ?? 800;
    return { fuel: f._id, pricePerUnit: price, available: true };
  });

  // 3. Replace any prior copy so re-runs are idempotent.
  await GasStation.deleteMany({ name: STATION_NAME });

  const station = (await GasStation.create({
    name: STATION_NAME,
    address: "Auto-seeded near rider GPS",
    state: "Akwa Ibom",
    lga: "Uyo",
    location: { lat, lng },
    fuels: fuelEntries,
    rating: 4.6,
    image: "",
    images: [],
    verified: true,
    isActive: true,
    autoAcceptOrders: true,
    operatingHours: { open: "00:00", close: "23:59" },
    serviceTime: "10–15 min",
    paymentOptions: ["Card & POS", "Bank transfer"],
  } as any)) as any;

  console.log("\n✅ Station seeded\n");
  console.log({
    id: String(station._id),
    name: station.name,
    coords: station.location,
    riderCoords: rider.currentLocation,
    distanceFromRiderKm: Number(
      (
        Math.hypot(
          (lat - rider.currentLocation.lat) * 111,
          (lng - rider.currentLocation.lng) *
            111 *
            Math.cos((lat * Math.PI) / 180),
        )
      ).toFixed(2),
    ),
    autoAcceptOrders: station.autoAcceptOrders,
    fuels: fuelEntries.length,
  });

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
