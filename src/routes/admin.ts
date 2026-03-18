import { Router } from "express";
import { requireAuth, requireAdmin } from "../middleware/auth";
import User from "../models/User";
import GasStation from "../models/Station";
import Order from "../models/Order";
import RiderProfile from "../models/RiderProfile";
import Earning from "../models/Earning";
import Delivery from "../models/Delivery";

const router = Router();

// All admin routes require auth + admin role
router.use(requireAuth, requireAdmin);

// ===================== PLATFORM STATS =====================
router.get("/stats", async (_req, res) => {
  try {
    const [
      usersByRole,
      ordersByStatus,
      revenueAgg,
      earningsByStatus,
      activeRiders,
      stationCount,
    ] = await Promise.all([
      User.aggregate([{ $group: { _id: "$role", count: { $sum: 1 } } }]),
      Order.aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }]),
      Order.aggregate([
        { $match: { status: "delivered" } },
        { $group: { _id: null, totalRevenue: { $sum: "$totalPrice" }, totalFuelCost: { $sum: "$fuelCost" }, totalDeliveryFee: { $sum: "$deliveryFee" } } },
      ]),
      Earning.aggregate([{ $group: { _id: "$status", total: { $sum: "$amount" } } }]),
      RiderProfile.countDocuments({ isAvailable: true }),
      GasStation.countDocuments(),
    ]);

    const users: Record<string, number> = {};
    for (const r of usersByRole) users[r._id] = r.count;

    const orders: Record<string, number> = {};
    for (const r of ordersByStatus) orders[r._id] = r.count;

    const revenue = revenueAgg[0] ?? { totalRevenue: 0, totalFuelCost: 0, totalDeliveryFee: 0 };

    const earnings: Record<string, number> = {};
    for (const r of earningsByStatus) earnings[r._id] = r.total;

    res.json({
      users,
      orders,
      revenue: {
        total: revenue.totalRevenue,
        fuelCost: revenue.totalFuelCost,
        deliveryFee: revenue.totalDeliveryFee,
      },
      earnings: {
        pending: earnings.pending ?? 0,
        settled: earnings.settled ?? 0,
      },
      riders: { active: activeRiders },
      stations: { total: stationCount },
    });
  } catch (err) {
    res.status(500).json({ message: "Failed to fetch stats" });
  }
});

// ===================== LIST USERS =====================
router.get("/users", async (req, res) => {
  try {
    const { role, page = "1", limit = "20", search } = req.query as Record<string, string>;
    const pageNum = Math.max(1, parseInt(page, 10));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10)));
    const skip = (pageNum - 1) * limitNum;

    const filter: Record<string, unknown> = {};
    if (role) filter.role = role;
    if (search) {
      filter.$or = [
        { displayName: { $regex: search, $options: "i" } },
        { email: { $regex: search, $options: "i" } },
      ];
    }

    const [users, total] = await Promise.all([
      User.find(filter)
        .select("-passwordHash -otpCode -otpExpiresAt -deviceTokens")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .lean(),
      User.countDocuments(filter),
    ]);

    res.json({ users, total, page: pageNum, pages: Math.ceil(total / limitNum) });
  } catch (err) {
    res.status(500).json({ message: "Failed to fetch users" });
  }
});

// ===================== UPDATE USER ROLE =====================
router.patch("/users/:id/role", async (req, res) => {
  try {
    const { role } = req.body;
    const validRoles = ["customer", "vendor", "rider", "admin"];
    if (!validRoles.includes(role)) {
      return res.status(400).json({ message: "Invalid role" });
    }

    const user = await User.findByIdAndUpdate(
      req.params.id,
      { role },
      { new: true }
    ).select("-passwordHash -otpCode -otpExpiresAt");

    if (!user) return res.status(404).json({ message: "User not found" });

    res.json({ message: "Role updated", user });
  } catch (err) {
    res.status(500).json({ message: "Failed to update role" });
  }
});

// ===================== LIST STATIONS =====================
router.get("/stations", async (req, res) => {
  try {
    const { verified, page = "1", limit = "20", search } = req.query as Record<string, string>;
    const pageNum = Math.max(1, parseInt(page, 10));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10)));
    const skip = (pageNum - 1) * limitNum;

    const filter: Record<string, unknown> = {};
    if (verified !== undefined) filter.verified = verified === "true";
    if (search) filter.$text = { $search: search };

    const [stations, total] = await Promise.all([
      GasStation.find(filter)
        .populate("vendorId", "displayName email")
        .populate("fuels.fuel", "name unit")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .lean(),
      GasStation.countDocuments(filter),
    ]);

    res.json({ stations, total, page: pageNum, pages: Math.ceil(total / limitNum) });
  } catch (err) {
    res.status(500).json({ message: "Failed to fetch stations" });
  }
});

// ===================== VERIFY / UNVERIFY STATION =====================
router.patch("/stations/:id/verify", async (req, res) => {
  try {
    const { verified } = req.body;
    if (typeof verified !== "boolean") {
      return res.status(400).json({ message: "verified (boolean) is required" });
    }

    const station = await GasStation.findByIdAndUpdate(
      req.params.id,
      { verified },
      { new: true }
    );

    if (!station) return res.status(404).json({ message: "Station not found" });

    res.json({ message: `Station ${verified ? "verified" : "unverified"}`, station });
  } catch (err) {
    res.status(500).json({ message: "Failed to update station" });
  }
});

// ===================== TOGGLE STATION ACTIVE =====================
router.patch("/stations/:id/active", async (req, res) => {
  try {
    const { isActive } = req.body;
    if (typeof isActive !== "boolean") {
      return res.status(400).json({ message: "isActive (boolean) is required" });
    }

    const station = await GasStation.findByIdAndUpdate(
      req.params.id,
      { isActive },
      { new: true }
    );

    if (!station) return res.status(404).json({ message: "Station not found" });

    res.json({ message: "Station updated", station });
  } catch (err) {
    res.status(500).json({ message: "Failed to update station" });
  }
});

// ===================== LIST ALL ORDERS =====================
router.get("/orders", async (req, res) => {
  try {
    const { status, page = "1", limit = "20" } = req.query as Record<string, string>;
    const pageNum = Math.max(1, parseInt(page, 10));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10)));
    const skip = (pageNum - 1) * limitNum;

    const filter: Record<string, unknown> = {};
    if (status) filter.status = status;

    const [orders, total] = await Promise.all([
      Order.find(filter)
        .populate("user", "displayName email")
        .populate("fuel", "name unit")
        .populate("station", "name state")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .lean(),
      Order.countDocuments(filter),
    ]);

    res.json({ orders, total, page: pageNum, pages: Math.ceil(total / limitNum) });
  } catch (err) {
    res.status(500).json({ message: "Failed to fetch orders" });
  }
});

// ===================== LIST RIDER PROFILES =====================
router.get("/riders", async (req, res) => {
  try {
    const { verified, page = "1", limit = "20" } = req.query as Record<string, string>;
    const pageNum = Math.max(1, parseInt(page, 10));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10)));
    const skip = (pageNum - 1) * limitNum;

    const filter: Record<string, unknown> = {};
    if (verified !== undefined) filter.isVerified = verified === "true";

    const [riders, total] = await Promise.all([
      RiderProfile.find(filter)
        .populate("user", "displayName email phone")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .lean(),
      RiderProfile.countDocuments(filter),
    ]);

    res.json({ riders, total, page: pageNum, pages: Math.ceil(total / limitNum) });
  } catch (err) {
    res.status(500).json({ message: "Failed to fetch riders" });
  }
});

// ===================== VERIFY / UNVERIFY RIDER =====================
router.patch("/riders/:id/verify", async (req, res) => {
  try {
    const { isVerified } = req.body;
    if (typeof isVerified !== "boolean") {
      return res.status(400).json({ message: "isVerified (boolean) is required" });
    }

    const profile = await RiderProfile.findByIdAndUpdate(
      req.params.id,
      { isVerified },
      { new: true }
    );

    if (!profile) return res.status(404).json({ message: "Rider profile not found" });

    res.json({ message: `Rider ${isVerified ? "verified" : "unverified"}`, profile });
  } catch (err) {
    res.status(500).json({ message: "Failed to update rider" });
  }
});

// ===================== SETTLE EARNINGS =====================
// Mark a batch of pending earnings as settled (manual trigger for now)
router.patch("/earnings/settle", async (req, res) => {
  try {
    const { role } = req.body; // "vendor" | "rider" | undefined (both)
    const filter: Record<string, unknown> = { status: "pending" };
    if (role) filter.role = role;

    const result = await Earning.updateMany(filter, {
      status: "settled",
      settledAt: new Date(),
    });

    res.json({ message: "Earnings settled", count: result.modifiedCount });
  } catch (err) {
    res.status(500).json({ message: "Failed to settle earnings" });
  }
});

export default router;
