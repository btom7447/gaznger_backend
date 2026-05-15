import { Router } from "express";
import mongoose from "mongoose";
import multer from "multer";
import { requireAuth, requireVendor } from "../middleware/auth";
import User from "../models/User";
import GasStation from "../models/Station";
import Order from "../models/Order";
import Earning from "../models/Earning";
import Rating from "../models/Rating";
import { notifyUser } from "../utils/notify";
import { emitToUser } from "../socket";
import { createVendorPendingEarning } from "../utils/earningsUtils";
import Withdrawal from "../models/Withdrawal";
import cloudinary from "../utils/cloudinary";
import { listBanks, resolveBankAccount } from "../utils/paystack";
import { handleWithdrawRequest } from "../utils/withdraw";
import { moneyLimiter } from "../middleware/moneyLimiter";
import { idempotencyKey } from "../middleware/idempotency";

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ["image/jpeg", "image/png", "image/webp"];
    allowed.includes(file.mimetype) ? cb(null, true) : cb(new Error("Invalid file type"));
  },
});

async function uploadToCloudinary(buffer: Buffer): Promise<string> {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { resource_type: "image" },
      (err, result) => {
        if (err || !result?.secure_url) return reject(err ?? new Error("No URL"));
        resolve(result.secure_url);
      }
    );
    stream.end(buffer);
  });
}

// ===================== VENDOR ONBOARDING =====================
router.post("/onboard", requireAuth, requireVendor, async (req, res) => {
  try {
    const { stationName, stationType, address, state, lga, location, fuels, images, bankAccount } = req.body;

    if (!stationName || !address || !state || !lga || !fuels?.length) {
      return res.status(400).json({ message: "Missing required onboarding fields" });
    }

    const station = await GasStation.create({
      name: stationName,
      address,
      state,
      lga,
      location: { lat: location?.lat ?? 0, lng: location?.lng ?? 0 },
      fuels,
      image: images?.[0] ?? "",
      images: images ?? [],
      verified: false,
      vendorId: req.userId,
      isActive: true,
    });

    // Only update bank account + onboarded on first station
    const user = await User.findById(req.userId);
    const isFirstStation = !user?.isOnboarded;
    if (isFirstStation || bankAccount?.bankName) {
      await User.findByIdAndUpdate(req.userId, {
        isOnboarded: true,
        "vendorBankAccount.bankName": bankAccount?.bankName ?? "",
        "vendorBankAccount.accountNumber": bankAccount?.accountNumber ?? "",
        "vendorBankAccount.accountName": bankAccount?.accountName ?? "",
      });
    } else {
      await User.findByIdAndUpdate(req.userId, { isOnboarded: true });
    }

    res.status(201).json({ message: "Station created successfully", stationId: station._id });
  } catch (err) {
    res.status(500).json({ message: "Onboarding failed" });
  }
});

// ===================== LIST ALL VENDOR STATIONS =====================
router.get("/stations", requireAuth, requireVendor, async (req, res) => {
  try {
    const stations = await GasStation.find({ vendorId: req.userId })
      .populate("fuels.fuel")
      .lean();
    // Apply any due scheduled prices
    for (const station of stations) {
      let dirty = false;
      for (const f of station.fuels as any[]) {
        if (f.scheduledPrice?.effectiveAt && new Date(f.scheduledPrice.effectiveAt) <= new Date()) {
          f.pricePerUnit = f.scheduledPrice.price;
          f.scheduledPrice = undefined;
          dirty = true;
        }
      }
      if (dirty) {
        await GasStation.findByIdAndUpdate(station._id, { fuels: station.fuels });
      }
    }
    res.json({ stations });
  } catch (err) {
    res.status(500).json({ message: "Failed to fetch stations" });
  }
});

// ===================== CREATE ADDITIONAL STATION =====================
router.post("/stations", requireAuth, requireVendor, async (req, res) => {
  try {
    const { stationName, address, state, lga, location, fuels, images } = req.body;
    if (!stationName || !address || !state || !lga || !fuels?.length) {
      return res.status(400).json({ message: "Missing required fields" });
    }
    const station = await GasStation.create({
      name: stationName,
      address,
      state,
      lga,
      location: { lat: location?.lat ?? 0, lng: location?.lng ?? 0 },
      fuels,
      image: images?.[0] ?? "",
      images: images ?? [],
      verified: false,
      vendorId: req.userId,
      isActive: true,
    });
    res.status(201).json({ message: "Station created", stationId: station._id });
  } catch (err) {
    res.status(500).json({ message: "Failed to create station" });
  }
});

// ===================== GET VENDOR PROFILE + ALL STATIONS =====================
router.get("/profile", requireAuth, requireVendor, async (req, res) => {
  try {
    const [user, stations] = await Promise.all([
      User.findById(req.userId).select("-passwordHash -otpCode -otpExpiresAt").lean(),
      GasStation.find({ vendorId: req.userId }).populate("fuels.fuel").lean(),
    ]);
    res.json({ user, stations, station: stations[0] ?? null });
  } catch (err) {
    res.status(500).json({ message: "Failed to fetch vendor profile" });
  }
});

// ===================== UPDATE COMPANY PROFILE (name, phone) =====================
router.patch("/profile", requireAuth, requireVendor, async (req, res) => {
  try {
    const { displayName, phone } = req.body;
    const update: Record<string, unknown> = {};
    if (displayName !== undefined) update.displayName = displayName.trim();
    if (phone !== undefined) update.phone = phone.trim();
    if (Object.keys(update).length === 0) return res.status(400).json({ message: "Nothing to update" });
    const user = await User.findByIdAndUpdate(req.userId, { $set: update }, { new: true })
      .select("-passwordHash -otpCode -otpExpiresAt").lean();
    res.json({ message: "Profile updated", user });
  } catch (err) {
    res.status(500).json({ message: "Failed to update profile" });
  }
});

// ===================== UPDATE PROFILE PICTURE =====================
router.patch("/profile/picture", requireAuth, requireVendor, upload.single("image"), async (req, res) => {
  try {
    if (!req.file?.buffer) return res.status(400).json({ message: "Image required" });
    const url = await uploadToCloudinary(req.file.buffer);
    await User.findByIdAndUpdate(req.userId, { profileImage: url });
    res.json({ profileImage: url });
  } catch (err) {
    res.status(500).json({ message: "Profile picture update failed" });
  }
});

// ===================== TODAY (hero) =====================
/**
 * GET /api/vendor/today?stationId=<id>
 *
 * Aggregated snapshot for the Vendor Today (hero) screen. Scoped to a
 * single station — vendor app sends the active station id from
 * useVendorStationStore. Falls back to "all stations owned by this
 * vendor" when stationId is omitted.
 *
 * Response shape (one round-trip, mobile renders the hero immediately):
 *
 *   {
 *     stationName: string | null,
 *     revenueToday: number,        // NGN whole units (not kobo)
 *     breakdown: {
 *       ordersDone: number,        // delivered today
 *       ordersInFlight: number,    // confirmed | assigned | in-transit | ...
 *       bulkInTransit: number,     // bulk fuel purchases mid-pipeline
 *     },
 *     alerts: Array<{
 *       id: string,
 *       tone: "warning" | "info" | "success" | "error" | "primary",
 *       title: string,
 *       sub?: string,
 *       cta?: string,
 *       route?: string,            // mobile pushes this on chip tap
 *     }>,
 *     nextOrder: { ... } | null,   // oldest unassigned order in queue
 *     teamStatus: {
 *       active: number,            // riders currently on an order at this station
 *       idle: number,               // available, not on order
 *       offline: number,            // ever delivered here, currently unavailable
 *     },
 *     queue: Array<OrderPreview>,  // up to 3 most-recent queue rows
 *   }
 *
 * "Team" infers from past Order assignments. Proper Team model lands
 * in Phase 5 with a vendor↔rider affiliation document; until then a
 * rider is "on this vendor's team" iff they've delivered an order at
 * one of this vendor's stations in the last 30 days.
 */
router.get("/today", requireAuth, requireVendor, async (req, res) => {
  try {
    const stations = await GasStation.find({ vendorId: req.userId })
      .select("_id name")
      .lean();
    if (!stations.length) {
      return res.status(200).json({
        stationName: null,
        revenueToday: 0,
        breakdown: { ordersDone: 0, ordersInFlight: 0, bulkInTransit: 0 },
        alerts: [],
        nextOrder: null,
        teamStatus: { active: 0, idle: 0, offline: 0 },
        queue: [],
      });
    }

    const allStationIds = stations.map((s) => s._id);
    const { stationId } = req.query as { stationId?: string };
    const scopedStationIds =
      stationId && allStationIds.some((id) => id.toString() === stationId)
        ? [new mongoose.Types.ObjectId(stationId)]
        : allStationIds;
    const stationName =
      stationId && scopedStationIds.length === 1
        ? stations.find((s) => s._id.toString() === stationId)?.name ?? null
        : null;

    // Day boundary in Africa/Lagos (UTC+1, no DST). Mongo timestamps are
    // UTC; we shift the window so "today" matches local-time perception.
    const now = new Date();
    const lagosOffsetMin = -60; // UTC+1 → offset of UTC FROM Lagos is -60
    const lagosNow = new Date(now.getTime() - lagosOffsetMin * 60_000);
    const startOfLagosDay = new Date(
      Date.UTC(
        lagosNow.getUTCFullYear(),
        lagosNow.getUTCMonth(),
        lagosNow.getUTCDate(),
      ) +
        lagosOffsetMin * 60_000,
    );

    const ACTIVE_STATUSES = [
      "pending",
      "confirmed",
      "assigned",
      "in-transit",
      "at_plant",
      "refilling",
      "returning",
      "arrived",
      "dispensing",
      "awaiting_confirmation",
    ];

    // Parallel fan-out — every count is a Mongo COUNT() under the hood.
    const [
      ordersDone,
      ordersInFlight,
      revenueAgg,
      nextOrderDoc,
      queueDocs,
      bulkInTransitDoc,
    ] = await Promise.all([
      Order.countDocuments({
        station: { $in: scopedStationIds },
        status: "delivered",
        deliveredAt: { $gte: startOfLagosDay },
      }),
      Order.countDocuments({
        station: { $in: scopedStationIds },
        status: { $in: ACTIVE_STATUSES },
      }),
      Order.aggregate([
        {
          $match: {
            station: { $in: scopedStationIds },
            status: "delivered",
            deliveredAt: { $gte: startOfLagosDay },
          },
        },
        // Sum the vendor-relevant slice of each order: fuelCost. We
        // intentionally don't include deliveryFee (that's the rider's)
        // or serviceFee (that's the platform's).
        { $group: { _id: null, total: { $sum: "$fuelCost" } } },
      ]),
      Order.findOne({
        station: { $in: scopedStationIds },
        status: { $in: ["pending", "confirmed"] },
        riderId: { $exists: false },
      })
        .sort({ createdAt: 1 })
        .populate("user", "displayName")
        .populate("fuel", "name unit")
        .populate("station", "name")
        .lean(),
      Order.find({
        station: { $in: scopedStationIds },
        status: { $in: ACTIVE_STATUSES },
      })
        .sort({ createdAt: -1 })
        .limit(3)
        .populate("user", "displayName")
        .populate("fuel", "name unit")
        .populate("station", "name")
        .lean(),
      // Bulk fuel purchases mid-pipeline.
      (async () => {
        try {
          const FuelPlantOrder = (await import("../models/FuelPlantOrder"))
            .default;
          return await FuelPlantOrder.countDocuments({
            vendor: req.userId,
            status: { $in: ["pending", "confirmed", "in-transit"] },
          });
        } catch {
          return 0;
        }
      })(),
    ]);

    const revenueToday = revenueAgg[0]?.total ?? 0;

    // Map nextOrder + queue into a slim shape the mobile renders directly.
    const orderToPreview = (o: any) => ({
      id: String(o._id),
      customer: o.user?.displayName ?? "Customer",
      fuel: o.fuel?.name ?? "Fuel",
      qty: `${o.quantity ?? 0} ${o.fuel?.unit ?? ""}`.trim(),
      price: `₦${Number(o.totalPrice ?? 0).toLocaleString("en-NG")}`,
      status: o.status,
      etaMin: null,
      addr: o.station?.name ?? null,
    });

    // Team status — riders who delivered at this vendor's stations in
    // the last 30 days. Bucket by current availability.
    const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
    const thirtyDaysAgo = new Date(Date.now() - THIRTY_DAYS_MS);
    const riderIds = await Order.distinct("riderId", {
      station: { $in: scopedStationIds },
      riderId: { $exists: true },
      deliveredAt: { $gte: thirtyDaysAgo },
    });

    let teamActive = 0;
    let teamIdle = 0;
    let teamOffline = 0;
    if (riderIds.length > 0) {
      const RiderProfile = (await import("../models/RiderProfile")).default;
      const [profiles, activeOnOrder] = await Promise.all([
        RiderProfile.find({ user: { $in: riderIds } })
          .select("user isAvailable")
          .lean(),
        Order.distinct("riderId", {
          station: { $in: scopedStationIds },
          status: { $in: ACTIVE_STATUSES },
          riderId: { $in: riderIds },
        }),
      ]);
      const activeSet = new Set(activeOnOrder.map((r) => String(r)));
      for (const p of profiles) {
        if (activeSet.has(String(p.user))) teamActive += 1;
        else if (p.isAvailable) teamIdle += 1;
        else teamOffline += 1;
      }
    }

    // Alerts — derived from queue state + station inventory.
    const alerts: Array<{
      id: string;
      tone: "warning" | "info" | "success" | "error" | "primary";
      title: string;
      sub?: string;
      cta?: string;
      route?: string;
    }> = [];

    // (a) Pending > 90s and unassigned.
    if (nextOrderDoc) {
      const ageSec =
        (Date.now() - new Date((nextOrderDoc as any).createdAt).getTime()) /
        1000;
      if (ageSec > 90) {
        alerts.push({
          id: "pending-unassigned",
          tone: "warning",
          title: "Pending > 90s",
          sub: "Tap to assign a rider.",
          cta: "Assign",
          route: "/(vendor)/(orders)",
        });
      }
    }

    // (b) Stale dispatch — any order in 'confirmed' for > 5 min with no rider.
    const FIVE_MIN_AGO = new Date(Date.now() - 5 * 60 * 1000);
    const staleDispatchCount = await Order.countDocuments({
      station: { $in: scopedStationIds },
      status: "confirmed",
      riderId: { $exists: false },
      createdAt: { $lt: FIVE_MIN_AGO },
    });
    if (staleDispatchCount > 0) {
      alerts.push({
        id: "stale-dispatch",
        tone: "warning",
        title: `${staleDispatchCount} order${staleDispatchCount === 1 ? "" : "s"} need a rider`,
        sub: "Auto-dispatch hasn't matched yet.",
        cta: "Open",
        route: "/(vendor)/(orders)",
      });
    }

    res.json({
      stationName,
      revenueToday,
      breakdown: {
        ordersDone,
        ordersInFlight,
        bulkInTransit: bulkInTransitDoc ?? 0,
      },
      alerts,
      nextOrder: nextOrderDoc ? orderToPreview(nextOrderDoc) : null,
      teamStatus: {
        active: teamActive,
        idle: teamIdle,
        offline: teamOffline,
      },
      queue: queueDocs.map(orderToPreview),
    });
  } catch (err) {
    console.error("[vendor/today]", err);
    res.status(500).json({ message: "Failed to fetch today snapshot" });
  }
});

// ===================== GET VENDOR ORDERS (filter pills) =====================
/**
 * GET /api/vendor/orders
 *
 * v6 filter pills:
 *   ?filter=all       — every status (default)
 *   ?filter=new       — pending | confirmed (need rider assignment)
 *   ?filter=in-flight — any active status downstream of "assigned"
 *
 * Optional ?stationId scopes to one station; otherwise spans all the
 * vendor's stations. ?status= still accepted as raw enum for power
 * users / admin tooling; it overrides ?filter when both are supplied.
 *
 * Returns preformatted preview rows so the mobile OrderRow component
 * can render straight from the response.
 */
const FILTER_STATUS_GROUPS = {
  all: null as null | string[],
  new: ["pending", "confirmed"],
  "in-flight": [
    "assigned",
    "in-transit",
    "at_plant",
    "refilling",
    "returning",
    "arrived",
    "dispensing",
    "awaiting_confirmation",
  ],
} as const;

router.get("/orders", requireAuth, requireVendor, async (req, res) => {
  try {
    const stations = await GasStation.find({ vendorId: req.userId }).select("_id").lean();
    if (!stations.length) {
      return res.status(200).json({ orders: [], total: 0, page: 1, pages: 0 });
    }

    const allStationIds = stations.map((s) => s._id);
    const {
      status,
      filter: filterName,
      stationId,
      page = "1",
      limit = "20",
    } = req.query as Record<string, string>;
    const pageNum = Math.max(1, parseInt(page, 10));
    const limitNum = Math.min(50, Math.max(1, parseInt(limit, 10)));
    const skip = (pageNum - 1) * limitNum;

    const scopedStationIds =
      stationId && allStationIds.some((id) => id.toString() === stationId)
        ? [new mongoose.Types.ObjectId(stationId)]
        : allStationIds;

    const filter: Record<string, unknown> = { station: { $in: scopedStationIds } };
    if (status) {
      filter.status = status;
    } else if (filterName && filterName in FILTER_STATUS_GROUPS) {
      const group =
        FILTER_STATUS_GROUPS[filterName as keyof typeof FILTER_STATUS_GROUPS];
      if (group) filter.status = { $in: group };
    }

    const [docs, total] = await Promise.all([
      Order.find(filter)
        .populate("user", "displayName phone")
        .populate("fuel", "name unit")
        .populate("station", "name address")
        .populate("deliveryAddress", "street city")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .lean(),
      Order.countDocuments(filter),
    ]);

    const orders = docs.map((o: any) => {
      const qtyUnit = `${o.quantity ?? 0} ${o.fuel?.unit ?? ""}`.trim();
      // Address line — prefer deliveryAddress.street, fall back to the
      // first comma-stripped chunk of station.address.
      const addr =
        o.deliveryAddress?.street ??
        o.station?.address?.split(",")[0]?.trim() ??
        null;
      return {
        id: String(o._id),
        customer: o.user?.displayName ?? "Customer",
        phone: o.user?.phone ?? null,
        fuel: o.fuel?.name ?? "Fuel",
        qty: qtyUnit,
        price: `₦${Number(o.totalPrice ?? 0).toLocaleString("en-NG")}`,
        priceKobo: o.totalPrice ?? 0,
        status: o.status,
        addr,
        riderId: o.riderId ? String(o.riderId) : null,
        createdAt: o.createdAt,
        stationName: o.station?.name ?? null,
        // ETA is computed by the rider's GPS pings during in-transit; we
        // don't have a reliable static number for the list view, so the
        // mobile OrderRow accepts null.
        etaMin: null,
      };
    });

    res.json({
      orders,
      total,
      page: pageNum,
      pages: Math.ceil(total / limitNum),
    });
  } catch (err) {
    res.status(500).json({ message: "Failed to fetch orders" });
  }
});

// ===================== GET VENDOR ORDER BY ID =====================
/**
 * GET /api/vendor/orders/:id
 *
 * Order detail with everything the vendor needs to act on it: customer
 * (full info), fuel + qty + price math, address, current status,
 * assigned rider (if any), age. Vendor must own the station the order
 * belongs to.
 */
router.get("/orders/:id", requireAuth, requireVendor, async (req, res) => {
  try {
    const stations = await GasStation.find({ vendorId: req.userId })
      .select("_id")
      .lean();
    const stationIds = stations.map((s) => s._id);

    const order = (await Order.findOne({
      _id: req.params.id,
      station: { $in: stationIds },
    })
      .populate("user", "displayName phone profileImage")
      .populate("fuel", "name unit")
      .populate("station", "name address location")
      .populate("deliveryAddress", "street city state latitude longitude")
      .populate("riderId", "displayName phone profileImage")
      .lean()) as any;

    if (!order) return res.status(404).json({ message: "Order not found" });

    // Side-load rider plate + rating when assigned.
    let riderProfile: { plate?: string; rating?: number } | null = null;
    if (order.riderId) {
      const RiderProfile = (await import("../models/RiderProfile")).default;
      const rp = await RiderProfile.findOne({
        user:
          typeof order.riderId === "object" && order.riderId !== null && "_id" in order.riderId
            ? (order.riderId as any)._id
            : order.riderId,
      })
        .select("vehiclePlate rating")
        .lean();
      if (rp) riderProfile = { plate: rp.vehiclePlate, rating: rp.rating };
    }

    res.json({ ...order, riderProfile });
  } catch (err) {
    console.error("[vendor/orders/:id]", err);
    res.status(500).json({ message: "Failed to fetch order" });
  }
});

// ===================== VENDOR RIDERS (roster for assign sheet) =====================
/**
 * GET /api/vendor/riders?stationId=<id>
 *
 * Roster of riders the vendor can assign. Like /today's team-status,
 * derived from past 30-day Order assignments at the vendor's stations
 * until the proper vendor↔rider affiliation model lands in Phase 5.
 *
 * Each row carries everything the AssignRiderSheet needs to render:
 *   id, name, plate, rating, trips, distanceKm (optional), status,
 *   phone (for the copy action).
 *
 * Sorted: active first (so they're visible but greyed in the UI),
 * idle by rating desc, offline last by lastSeen desc.
 */
router.get("/riders", requireAuth, requireVendor, async (req, res) => {
  try {
    const stations = await GasStation.find({ vendorId: req.userId })
      .select("_id location")
      .lean();
    const allStationIds = stations.map((s) => s._id);
    if (!allStationIds.length) {
      return res.status(200).json({ riders: [] });
    }

    const { stationId } = req.query as { stationId?: string };
    const scopedStationIds =
      stationId && allStationIds.some((id) => id.toString() === stationId)
        ? [new mongoose.Types.ObjectId(stationId)]
        : allStationIds;

    // Active-status set — same shape as /today.
    const ACTIVE_STATUSES = [
      "pending",
      "confirmed",
      "assigned",
      "in-transit",
      "at_plant",
      "refilling",
      "returning",
      "arrived",
      "dispensing",
      "awaiting_confirmation",
    ];

    // Riders who delivered orders at any of these stations in the last
    // 30 days. Same heuristic as /today's team count.
    const THIRTY_DAYS_AGO = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const riderIds = await Order.distinct("riderId", {
      station: { $in: allStationIds },
      riderId: { $exists: true },
      deliveredAt: { $gte: THIRTY_DAYS_AGO },
    });
    if (!riderIds.length) {
      return res.status(200).json({ riders: [] });
    }

    const RiderProfile = (await import("../models/RiderProfile")).default;
    const [users, profiles, activeOnOrder, tripCounts] = await Promise.all([
      User.find({ _id: { $in: riderIds } })
        .select("displayName phone profileImage")
        .lean(),
      RiderProfile.find({ user: { $in: riderIds } })
        .select("user isAvailable vehiclePlate rating currentLocation")
        .lean(),
      Order.distinct("riderId", {
        station: { $in: scopedStationIds },
        status: { $in: ACTIVE_STATUSES },
        riderId: { $in: riderIds },
      }),
      Order.aggregate([
        {
          $match: {
            riderId: { $in: riderIds },
            station: { $in: scopedStationIds },
            status: "delivered",
          },
        },
        { $group: { _id: "$riderId", trips: { $sum: 1 } } },
      ]),
    ]);

    const activeSet = new Set(activeOnOrder.map((r) => String(r)));
    const tripsById = new Map(
      tripCounts.map((t: any) => [String(t._id), t.trips as number]),
    );
    const userById = new Map(users.map((u: any) => [String(u._id), u]));
    const profileById = new Map(
      profiles.map((p: any) => [String(p.user), p]),
    );

    // Optional distance — only when we have a single-station scope and
    // that station has coords. Cheap haversine in JS.
    const scopedStation =
      stationId && scopedStationIds.length === 1
        ? stations.find((s) => s._id.toString() === stationId)
        : null;
    const stationCoord =
      scopedStation?.location?.lat && scopedStation?.location?.lng
        ? { lat: scopedStation.location.lat, lng: scopedStation.location.lng }
        : null;
    const haversineKm = (
      a: { lat: number; lng: number },
      b: { lat: number; lng: number },
    ) => {
      const R = 6371;
      const dLat = ((b.lat - a.lat) * Math.PI) / 180;
      const dLng = ((b.lng - a.lng) * Math.PI) / 180;
      const x =
        Math.sin(dLat / 2) ** 2 +
        Math.cos((a.lat * Math.PI) / 180) *
          Math.cos((b.lat * Math.PI) / 180) *
          Math.sin(dLng / 2) ** 2;
      return 2 * R * Math.asin(Math.sqrt(x));
    };

    const rows = riderIds.map((rid) => {
      const id = String(rid);
      const u = userById.get(id);
      const p = profileById.get(id);
      const isActive = activeSet.has(id);
      const isAvailable = !!p?.isAvailable;
      const status: "active" | "idle" | "offline" = isActive
        ? "active"
        : isAvailable
          ? "idle"
          : "offline";
      const distanceKm =
        stationCoord && p?.currentLocation?.lat && p?.currentLocation?.lng
          ? Number(
              haversineKm(stationCoord, {
                lat: p.currentLocation.lat,
                lng: p.currentLocation.lng,
              }).toFixed(1),
            )
          : null;
      return {
        id,
        name: u?.displayName ?? "Rider",
        phone: u?.phone ?? null,
        plate: p?.vehiclePlate ?? null,
        rating: typeof p?.rating === "number" ? p.rating : null,
        trips: tripsById.get(id) ?? 0,
        distanceKm,
        status,
      };
    });

    // Sort: idle first (by rating desc, then nearest), active next, offline last.
    rows.sort((a, b) => {
      const rank = (r: typeof a) =>
        r.status === "idle" ? 0 : r.status === "active" ? 1 : 2;
      if (rank(a) !== rank(b)) return rank(a) - rank(b);
      if (a.status === "idle" && b.status === "idle") {
        const ra = a.rating ?? 0;
        const rb = b.rating ?? 0;
        if (ra !== rb) return rb - ra;
        const da = a.distanceKm ?? Infinity;
        const db = b.distanceKm ?? Infinity;
        return da - db;
      }
      return 0;
    });

    res.json({ riders: rows });
  } catch (err) {
    console.error("[vendor/riders]", err);
    res.status(500).json({ message: "Failed to fetch riders" });
  }
});

// ===================== ASSIGN RIDER (vendor manual override) =====================
/**
 * PATCH /api/vendor/orders/:id/assign  { riderId }
 *
 * Vendor explicitly picks a rider. Allowed when order is in
 * "pending" or "confirmed" with no current riderId, OR via /reassign
 * for orders that already have a rider.
 *
 * Side effects:
 *   - Order.status → "assigned"
 *   - Order.riderId → req.body.riderId
 *   - Order.riderAssignedAt → now
 *   - Delete any pending broadcast Delivery rows for this order so
 *     the auto-dispatch cron doesn't fight us.
 *   - Create a single Delivery row for the picked rider (status:
 *     "accepted" — the rider didn't accept via broadcast, but the
 *     vendor's manual assign is equivalent for downstream code).
 *   - Emit socket order:update to customer + delivery:dispatch to rider.
 */
router.patch("/orders/:id/assign", requireAuth, requireVendor, async (req, res) => {
  try {
    const { riderId } = req.body as { riderId?: string };
    if (!riderId) return res.status(400).json({ message: "riderId required" });

    const stations = await GasStation.find({ vendorId: req.userId })
      .select("_id")
      .lean();
    const stationIds = stations.map((s) => s._id);

    const order = await Order.findOne({
      _id: req.params.id,
      station: { $in: stationIds },
    });
    if (!order) return res.status(404).json({ message: "Order not found" });

    // Only assignable while no rider is committed yet. /reassign covers
    // the "rider already assigned, swap them" case.
    if (
      !["pending", "confirmed"].includes(order.status) ||
      order.riderId
    ) {
      return res.status(409).json({
        message: "Order is no longer in an assignable state",
      });
    }

    const Delivery = (await import("../models/Delivery")).default;
    await Delivery.deleteMany({ order: order._id, status: "pending" });

    const delivery = await Delivery.create({
      order: order._id,
      rider: riderId,
      station: order.station,
      status: "accepted",
      riderEarnings: 0,
      platformEarnings: 0,
    });

    order.status = "assigned";
    order.riderId = new mongoose.Types.ObjectId(riderId);
    order.riderAssignedAt = new Date();
    await order.save();

    // Socket — customer hears the new rider, rider hears the new gig.
    emitToUser(order.user.toString(), "order:update", {
      orderId: String(order._id),
      status: "assigned",
      riderId,
    });
    emitToUser(riderId, "delivery:dispatch", {
      deliveryId: delivery._id,
      orderId: order._id,
    });
    notifyUser(
      riderId,
      "dispatch",
      "New delivery assigned",
      "Open the app to start the trip.",
    ).catch(() => {});

    res.json({ order, delivery });
  } catch (err) {
    console.error("[vendor/orders/:id/assign]", err);
    res.status(500).json({ message: "Failed to assign rider" });
  }
});

// ===================== REASSIGN RIDER (mid-flight swap) =====================
/**
 * PATCH /api/vendor/orders/:id/reassign  { riderId }
 *
 * Vendor swaps the rider on an already-assigned order. Permitted only
 * before pickup ("assigned" / "in-transit"). The previous rider's
 * Delivery row is moved to "dropped" so settlement math stays honest.
 */
router.patch(
  "/orders/:id/reassign",
  requireAuth,
  requireVendor,
  async (req, res) => {
    try {
      const { riderId } = req.body as { riderId?: string };
      if (!riderId) return res.status(400).json({ message: "riderId required" });

      const stations = await GasStation.find({ vendorId: req.userId })
        .select("_id")
        .lean();
      const stationIds = stations.map((s) => s._id);

      const order = await Order.findOne({
        _id: req.params.id,
        station: { $in: stationIds },
      });
      if (!order) return res.status(404).json({ message: "Order not found" });

      if (!["assigned", "in-transit"].includes(order.status)) {
        return res.status(409).json({
          message: "Order is past the point where rider can be swapped",
        });
      }
      if (order.riderId?.toString() === riderId) {
        return res.status(409).json({ message: "Already this rider" });
      }

      const Delivery = (await import("../models/Delivery")).default;
      // Mark the previous rider's delivery dropped.
      if (order.riderId) {
        await Delivery.updateMany(
          { order: order._id, rider: order.riderId, status: { $in: ["accepted", "picked_up"] } },
          { $set: { status: "dropped" } },
        );
      }

      const delivery = await Delivery.create({
        order: order._id,
        rider: riderId,
        station: order.station,
        status: "accepted",
        riderEarnings: 0,
        platformEarnings: 0,
      });

      const previousRiderId = order.riderId?.toString();
      order.riderId = new mongoose.Types.ObjectId(riderId);
      order.riderAssignedAt = new Date();
      // Status stays "assigned" — reassign before pickup; downstream
      // events flip status as the new rider progresses.
      order.status = "assigned";
      await order.save();

      emitToUser(order.user.toString(), "order:update", {
        orderId: String(order._id),
        status: "assigned",
        riderId,
      });
      emitToUser(riderId, "delivery:dispatch", {
        deliveryId: delivery._id,
        orderId: order._id,
      });
      if (previousRiderId) {
        emitToUser(previousRiderId, "delivery:cancelled", {
          orderId: String(order._id),
        });
      }

      res.json({ order, delivery });
    } catch (err) {
      console.error("[vendor/orders/:id/reassign]", err);
      res.status(500).json({ message: "Failed to reassign rider" });
    }
  },
);

// ===================== CANCEL ORDER (vendor-initiated) =====================
/**
 * PATCH /api/vendor/orders/:id/cancel  { reason? }
 *
 * Vendor cancels — typically because tanks ran dry or station is
 * closing early. Allowed for any pre-delivery status. Refund flow runs
 * server-side on the customer side via Payment.refund (out of scope
 * for this slice; payment routes already handle it).
 */
router.patch(
  "/orders/:id/cancel",
  requireAuth,
  requireVendor,
  async (req, res) => {
    try {
      const { reason } = req.body as { reason?: string };
      const stations = await GasStation.find({ vendorId: req.userId })
        .select("_id")
        .lean();
      const stationIds = stations.map((s) => s._id);

      const order = await Order.findOne({
        _id: req.params.id,
        station: { $in: stationIds },
      });
      if (!order) return res.status(404).json({ message: "Order not found" });

      const TERMINAL = ["delivered", "cancelled"];
      if (TERMINAL.includes(order.status)) {
        return res.status(409).json({
          message: "Order is already terminal",
        });
      }

      order.status = "cancelled";
      order.cancellationReason = reason?.trim() || "Vendor cancelled";
      await order.save();

      // Tidy: drop any in-flight Delivery rows.
      const Delivery = (await import("../models/Delivery")).default;
      await Delivery.updateMany(
        { order: order._id, status: { $in: ["pending", "accepted", "picked_up"] } },
        { $set: { status: "dropped" } },
      );

      emitToUser(order.user.toString(), "order:update", {
        orderId: String(order._id),
        status: "cancelled",
      });
      notifyUser(
        order.user.toString(),
        "cancelled",
        "Order cancelled",
        order.cancellationReason,
      ).catch(() => {});

      res.json({ order });
    } catch (err) {
      console.error("[vendor/orders/:id/cancel]", err);
      res.status(500).json({ message: "Failed to cancel order" });
    }
  },
);

// ===================== CONFIRM ORDER =====================
router.patch("/orders/:id/confirm", requireAuth, requireVendor, async (req, res) => {
  try {
    const stations = await GasStation.find({ vendorId: req.userId }).select("_id").lean();
    const stationIds = stations.map((s) => s._id);

    const order = await Order.findOneAndUpdate(
      { _id: req.params.id, station: { $in: stationIds }, status: "pending" },
      { status: "confirmed" },
      { new: true }
    );
    if (!order) return res.status(404).json({ message: "Order not found or already actioned" });

    const customerId = order.user.toString();

    // Instant socket events first
    emitToUser(customerId, "order:update", { orderId: String(order._id), status: "confirmed" });
    emitToUser(req.userId!, "order:update", { orderId: String(order._id), status: "confirmed" });

    // Create vendor pending earning (net of platform commission) + emit
    createVendorPendingEarning(req.userId!, order._id.toString(), order.fuelCost).catch(() => {});

    // Background: DB notifications + push
    Promise.all([
      notifyUser(customerId, "order", "Order Confirmed",
        "Your order has been confirmed by the station. A rider will be assigned shortly."),
      notifyUser(req.userId!, "payment", "Earnings Added",
        `₦${order.fuelCost.toLocaleString()} added to your pending earnings for a confirmed order.`),
    ]).catch(() => {});

    res.json({ message: "Order confirmed", orderId: order._id, status: order.status });
  } catch (err) {
    res.status(500).json({ message: "Failed to confirm order" });
  }
});

// ===================== REJECT ORDER =====================
router.patch("/orders/:id/reject", requireAuth, requireVendor, async (req, res) => {
  try {
    const stations = await GasStation.find({ vendorId: req.userId }).select("_id").lean();
    const stationIds = stations.map((s) => s._id);
    const { reason } = req.body;

    const order = await Order.findOneAndUpdate(
      { _id: req.params.id, station: { $in: stationIds }, status: { $in: ["pending", "confirmed"] } },
      { status: "cancelled", cancellationReason: reason ?? "Rejected by vendor" },
      { new: true }
    );
    if (!order) return res.status(404).json({ message: "Order not found or cannot be rejected" });

    const customerId = order.user.toString();

    // Instant socket events first
    emitToUser(customerId, "order:update", { orderId: String(order._id), status: "cancelled" });
    emitToUser(req.userId!, "order:update", { orderId: String(order._id), status: "cancelled" });

    // Background notification
    notifyUser(customerId, "cancelled", "Order Rejected",
      reason ?? "Your order was rejected by the station.").catch(() => {});

    res.json({ message: "Order rejected", orderId: order._id, status: order.status });
  } catch (err) {
    res.status(500).json({ message: "Failed to reject order" });
  }
});

// ===================== UPDATE FUEL PRICE / AVAILABILITY FOR A STATION =====================
// Body: { fuelId, pricePerUnit?, available?, stationId? }
// stationId optional — defaults to first station for backwards compat
router.patch("/station/fuels", requireAuth, requireVendor, async (req, res) => {
  try {
    const { fuelId, pricePerUnit, available, stationId } = req.body;
    if (!fuelId) return res.status(400).json({ message: "fuelId is required" });

    const query = stationId
      ? { _id: stationId, vendorId: req.userId }
      : { vendorId: req.userId };

    const update: Record<string, unknown> = {};
    if (pricePerUnit !== undefined) update["fuels.$[elem].pricePerUnit"] = pricePerUnit;
    if (available !== undefined) update["fuels.$[elem].available"] = available;

    if (Object.keys(update).length === 0) return res.status(400).json({ message: "Nothing to update" });

    const station = await GasStation.findOneAndUpdate(
      query,
      { $set: update },
      { arrayFilters: [{ "elem.fuel": fuelId }], new: true }
    ).populate("fuels.fuel");

    if (!station) return res.status(404).json({ message: "Station not found" });
    res.json({ message: "Fuel updated", fuels: station.fuels });
  } catch (err) {
    res.status(500).json({ message: "Failed to update fuel" });
  }
});

// ===================== SCHEDULE FUEL PRICE UPDATE =====================
// Body: { fuelId, newPrice, effectiveAt (ISO string), stationId? }
router.post("/station/fuels/schedule", requireAuth, requireVendor, async (req, res) => {
  try {
    const { fuelId, newPrice, effectiveAt, stationId } = req.body;
    if (!fuelId || !newPrice || !effectiveAt) {
      return res.status(400).json({ message: "fuelId, newPrice, and effectiveAt are required" });
    }

    const effectiveDate = new Date(effectiveAt);
    if (isNaN(effectiveDate.getTime()) || effectiveDate <= new Date()) {
      return res.status(400).json({ message: "effectiveAt must be a future date" });
    }

    const query = stationId
      ? { _id: stationId, vendorId: req.userId }
      : { vendorId: req.userId };

    const station = await GasStation.findOneAndUpdate(
      query,
      { $set: { "fuels.$[elem].scheduledPrice": { price: Number(newPrice), effectiveAt: effectiveDate } } },
      { arrayFilters: [{ "elem.fuel": fuelId }], new: true }
    ).populate("fuels.fuel");

    if (!station) return res.status(404).json({ message: "Station not found" });
    res.json({ message: "Price update scheduled", fuels: station.fuels });
  } catch (err) {
    res.status(500).json({ message: "Failed to schedule price update" });
  }
});

// ===================== CANCEL SCHEDULED PRICE =====================
router.delete("/station/fuels/schedule", requireAuth, requireVendor, async (req, res) => {
  try {
    const { fuelId, stationId } = req.body;
    if (!fuelId) return res.status(400).json({ message: "fuelId is required" });

    const query = stationId
      ? { _id: stationId, vendorId: req.userId }
      : { vendorId: req.userId };

    const station = await GasStation.findOneAndUpdate(
      query,
      { $unset: { "fuels.$[elem].scheduledPrice": "" } },
      { arrayFilters: [{ "elem.fuel": fuelId }], new: true }
    ).populate("fuels.fuel");

    if (!station) return res.status(404).json({ message: "Station not found" });
    res.json({ message: "Scheduled price cancelled", fuels: station.fuels });
  } catch (err) {
    res.status(500).json({ message: "Failed to cancel scheduled price" });
  }
});

// ===================== SET GLOBAL OPERATING HOURS (all stations) =====================
router.patch("/stations/operating-hours", requireAuth, requireVendor, async (req, res) => {
  try {
    const { open, close } = req.body;
    if (!open || !close) return res.status(400).json({ message: "open and close times are required" });

    await GasStation.updateMany(
      { vendorId: req.userId },
      { $set: { "operatingHours.open": open.trim(), "operatingHours.close": close.trim() } }
    );
    res.json({ message: "Operating hours updated for all stations" });
  } catch (err) {
    res.status(500).json({ message: "Failed to update operating hours" });
  }
});

// ===================== GET SINGLE STATION DETAIL =====================
router.get("/stations/:id", requireAuth, requireVendor, async (req, res) => {
  try {
    const station = await GasStation.findOne({ _id: req.params.id, vendorId: req.userId })
      .populate("fuels.fuel")
      .lean();
    if (!station) return res.status(404).json({ message: "Station not found" });
    res.json({ station });
  } catch (err) {
    res.status(500).json({ message: "Failed to fetch station" });
  }
});

// ===================== GET STATION REVIEWS =====================
router.get("/stations/:id/reviews", requireAuth, requireVendor, async (req, res) => {
  try {
    const station = await GasStation.findOne({ _id: req.params.id, vendorId: req.userId }).lean();
    if (!station) return res.status(404).json({ message: "Station not found" });

    const reviews = await Rating.find({ station: req.params.id })
      .populate("user", "displayName profileImage")
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();

    const avg = reviews.length
      ? reviews.reduce((sum, r) => sum + r.score, 0) / reviews.length
      : 0;

    res.json({ reviews, averageRating: Math.round(avg * 10) / 10, total: reviews.length });
  } catch (err) {
    res.status(500).json({ message: "Failed to fetch reviews" });
  }
});

// ===================== UPDATE SINGLE STATION INFO =====================
// Body: { stationId?, name?, address?, state?, lga?, isActive?, autoAcceptOrders?, operatingHours?, images?, location? }
router.patch("/station", requireAuth, requireVendor, async (req, res) => {
  try {
    const {
      stationId,
      name,
      address,
      state,
      lga,
      isActive,
      autoAcceptOrders,
      operatingHours,
      images,
      location,
      paymentOptions,
    } = req.body;
    const update: Record<string, unknown> = {};
    if (name !== undefined) update.name = name;
    if (address !== undefined) update.address = address;
    if (state !== undefined) update.state = state;
    if (lga !== undefined) update.lga = lga;
    if (isActive !== undefined) update.isActive = isActive;
    if (autoAcceptOrders !== undefined) update.autoAcceptOrders = autoAcceptOrders;
    if (operatingHours?.open !== undefined) update["operatingHours.open"] = operatingHours.open;
    if (operatingHours?.close !== undefined) update["operatingHours.close"] = operatingHours.close;
    if (images !== undefined) {
      update.images = images;
      if (images.length > 0) update.image = images[0];
    }
    if (location?.lat !== undefined) update["location.lat"] = Number(location.lat);
    if (location?.lng !== undefined) update["location.lng"] = Number(location.lng);
    // v6 station-edit: payment methods toggles. We persist the raw array
    // (e.g. ["Card & POS", "Bank transfer", "USSD"]); the customer app
    // already reads this for the amenity chips on the station detail.
    if (Array.isArray(paymentOptions)) {
      update.paymentOptions = paymentOptions.map(String);
    }

    if (Object.keys(update).length === 0) return res.status(400).json({ message: "Nothing to update" });

    const query = stationId
      ? { _id: stationId, vendorId: req.userId }
      : { vendorId: req.userId };

    const station = await GasStation.findOneAndUpdate(query, { $set: update }, { new: true });
    if (!station) return res.status(404).json({ message: "Station not found" });
    res.json({ message: "Station updated", station });
  } catch (err) {
    res.status(500).json({ message: "Failed to update station" });
  }
});

// ===================== UPDATE PAYOUT BANK ACCOUNT =====================
router.patch("/station/bank", requireAuth, requireVendor, async (req, res) => {
  try {
    const { bankName, accountNumber, accountName } = req.body;
    if (!bankName || !accountNumber || !accountName) {
      return res.status(400).json({ message: "bankName, accountNumber, and accountName are required" });
    }
    await User.findByIdAndUpdate(req.userId, {
      $set: {
        "vendorBankAccount.bankName": bankName.trim(),
        "vendorBankAccount.accountNumber": accountNumber.trim(),
        "vendorBankAccount.accountName": accountName.trim(),
      },
    });
    res.json({ message: "Bank account updated" });
  } catch (err) {
    res.status(500).json({ message: "Failed to update bank account" });
  }
});

// ===================== DELETE A STATION =====================
router.delete("/stations/:id", requireAuth, requireVendor, async (req, res) => {
  try {
    const station = await GasStation.findOneAndDelete({
      _id: req.params.id,
      vendorId: req.userId,
    });
    if (!station) return res.status(404).json({ message: "Station not found" });
    res.json({ message: "Station deleted", stationId: station._id });
  } catch (err) {
    res.status(500).json({ message: "Failed to delete station" });
  }
});

// ===================== GET VENDOR EARNINGS =====================
router.get("/earnings", requireAuth, requireVendor, async (req, res) => {
  try {
    const { page = "1", limit = "20" } = req.query as Record<string, string>;
    const pageNum = Math.max(1, parseInt(page, 10));
    const limitNum = Math.min(50, Math.max(1, parseInt(limit, 10)));
    const skip = (pageNum - 1) * limitNum;

    const [earnings, total, summary] = await Promise.all([
      Earning.find({ user: req.userId, role: "vendor" })
        .populate("order", "totalPrice fuelCost createdAt")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .lean(),
      Earning.countDocuments({ user: req.userId, role: "vendor" }),
      Earning.aggregate([
        { $match: { user: new mongoose.Types.ObjectId(req.userId), role: "vendor" } },
        { $group: { _id: "$status", total: { $sum: "$amount" } } },
      ]),
    ]);

    const totals = { pending: 0, settled: 0 };
    for (const s of summary) {
      if (s._id === "pending") totals.pending = s.total;
      if (s._id === "settled") totals.settled = s.total;
    }

    res.json({ earnings, total, page: pageNum, pages: Math.ceil(total / limitNum), summary: totals });
  } catch (err) {
    res.status(500).json({ message: "Failed to fetch earnings" });
  }
});

// ===================== SUBMIT VERIFICATION DOCUMENTS =====================
router.post("/verification/submit", requireAuth, requireVendor, async (req, res) => {
  try {
    const { documents } = req.body;
    if (!documents?.length) {
      return res.status(400).json({ message: "At least one document is required" });
    }

    const user = await User.findById(req.userId).lean();
    if ((user as any)?.vendorVerification?.status === "pending") {
      return res.status(409).json({ message: "Verification already submitted and under review" });
    }

    await User.findByIdAndUpdate(req.userId, {
      $set: {
        "vendorVerification.status": "pending",
        "vendorVerification.documents": documents,
        "vendorVerification.submittedAt": new Date(),
      },
    });

    res.json({ message: "Verification submitted successfully" });
  } catch (err) {
    res.status(500).json({ message: "Failed to submit verification" });
  }
});

// ===================== PAYSTACK BANK LIST (VENDOR) =====================
router.get("/banks", requireAuth, async (_req, res) => {
  try {
    const banks = await listBanks();
    res.json({ banks });
  } catch {
    res.status(500).json({ message: "Failed to fetch bank list" });
  }
});

// ===================== PAYSTACK RESOLVE BANK ACCOUNT (VENDOR) =====================
router.get("/bank/resolve", requireAuth, async (req, res) => {
  try {
    const { account_number, bank_code } = req.query as Record<string, string>;
    if (!account_number || !bank_code) {
      return res.status(400).json({ message: "account_number and bank_code are required" });
    }
    const result = await resolveBankAccount({ account_number, bank_code });
    res.json(result);
  } catch {
    res.status(400).json({ message: "Could not resolve account. Check the details and try again." });
  }
});

// ===================== REQUEST PAYOUT (VENDOR) =====================
// Implementation lives in utils/withdraw.ts (shared with rider route).
// Source of truth for balance is now `Wallet.available`, not Earning aggregates.
router.post(
  "/withdraw",
  requireAuth,
  requireVendor,
  moneyLimiter,
  idempotencyKey({ enforce: true }),
  async (req, res) => {
    await handleWithdrawRequest(req, res, "vendor");
  }
);

// ===================== SUBSCRIBE TO PARTNER BADGE =====================
router.post("/partner-badge/subscribe", requireAuth, requireVendor, async (req, res) => {
  try {
    const { plan } = req.body;
    const validPlans = ["monthly", "quarterly", "annual"];
    if (!plan || !validPlans.includes(plan)) {
      return res.status(400).json({ message: "plan must be monthly, quarterly, or annual" });
    }

    await User.findByIdAndUpdate(req.userId, {
      $set: {
        "partnerBadge.plan": plan,
        "partnerBadge.active": true,
        "partnerBadge.subscribedAt": new Date(),
      },
    });

    res.json({ message: "Partner badge subscription activated", plan });
  } catch (err) {
    res.status(500).json({ message: "Failed to activate partner badge" });
  }
});

export default router;
