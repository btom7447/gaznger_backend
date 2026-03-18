import { Router } from "express";
import mongoose from "mongoose";
import { requireAuth, requireVendor } from "../middleware/auth";
import User from "../models/User";
import GasStation from "../models/Station";
import Order from "../models/Order";
import Earning from "../models/Earning";
import { notifyUser } from "../utils/notify";

const router = Router();

// ===================== VENDOR ONBOARDING =====================
// Called at the end of the 5-step onboarding wizard.
// Creates the station, links it to the vendor, marks user as onboarded.
router.post("/onboard", requireAuth, requireVendor, async (req, res) => {
  try {
    const {
      stationName,
      stationType,
      address,
      state,
      lga,
      location,
      fuels,
      image,
      bankAccount,
    } = req.body;

    if (!stationName || !address || !state || !lga || !fuels?.length || !image) {
      return res.status(400).json({ message: "Missing required onboarding fields" });
    }

    // Prevent double-onboarding
    const existing = await GasStation.findOne({ vendorId: req.userId });
    if (existing) {
      return res.status(409).json({ message: "Station already created for this vendor" });
    }

    const station = await GasStation.create({
      name: stationName,
      address,
      state,
      lga,
      location: { lat: location?.lat ?? 0, lng: location?.lng ?? 0 },
      fuels,
      image,
      verified: false,
      vendorId: req.userId,
      isActive: true,
    });

    // Store bank account on user profile and mark onboarded
    await User.findByIdAndUpdate(req.userId, {
      isOnboarded: true,
      "vendorBankAccount.bankName": bankAccount?.bankName ?? "",
      "vendorBankAccount.accountNumber": bankAccount?.accountNumber ?? "",
      "vendorBankAccount.accountName": bankAccount?.accountName ?? "",
    });

    res.status(201).json({ message: "Station created successfully", stationId: station._id });
  } catch (err) {
    res.status(500).json({ message: "Onboarding failed" });
  }
});

// ===================== GET VENDOR PROFILE + STATION =====================
router.get("/profile", requireAuth, requireVendor, async (req, res) => {
  try {
    const [user, station] = await Promise.all([
      User.findById(req.userId).select("-passwordHash -otpCode -otpExpiresAt").lean(),
      GasStation.findOne({ vendorId: req.userId }).populate("fuels.fuel").lean(),
    ]);
    res.json({ user, station });
  } catch (err) {
    res.status(500).json({ message: "Failed to fetch vendor profile" });
  }
});

// ===================== GET VENDOR ORDERS =====================
// Returns orders placed at this vendor's station. Filter by status, paginated.
router.get("/orders", requireAuth, requireVendor, async (req, res) => {
  try {
    const station = await GasStation.findOne({ vendorId: req.userId }).select("_id").lean();
    if (!station) return res.status(404).json({ message: "Station not found" });

    const { status, page = "1", limit = "20" } = req.query as Record<string, string>;
    const pageNum = Math.max(1, parseInt(page, 10));
    const limitNum = Math.min(50, Math.max(1, parseInt(limit, 10)));
    const skip = (pageNum - 1) * limitNum;

    const filter: Record<string, unknown> = { station: station._id };
    if (status) filter.status = status;

    const [orders, total] = await Promise.all([
      Order.find(filter)
        .populate("user", "displayName phone")
        .populate("fuel", "name unit")
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

// ===================== CONFIRM ORDER =====================
router.patch("/orders/:id/confirm", requireAuth, requireVendor, async (req, res) => {
  try {
    const station = await GasStation.findOne({ vendorId: req.userId }).select("_id").lean();
    if (!station) return res.status(404).json({ message: "Station not found" });

    const order = await Order.findOneAndUpdate(
      { _id: req.params.id, station: station._id, status: "pending" },
      { status: "confirmed" },
      { new: true }
    );

    if (!order) {
      return res.status(404).json({ message: "Order not found or already actioned" });
    }

    // Notify customer their order has been confirmed
    await notifyUser(
      order.user.toString(),
      "order",
      "Order Confirmed",
      "Your order has been confirmed by the station. A rider will be assigned shortly."
    );

    res.json({ message: "Order confirmed", orderId: order._id, status: order.status });
  } catch (err) {
    res.status(500).json({ message: "Failed to confirm order" });
  }
});

// ===================== REJECT ORDER =====================
router.patch("/orders/:id/reject", requireAuth, requireVendor, async (req, res) => {
  try {
    const station = await GasStation.findOne({ vendorId: req.userId }).select("_id").lean();
    if (!station) return res.status(404).json({ message: "Station not found" });

    const { reason } = req.body;

    const order = await Order.findOneAndUpdate(
      {
        _id: req.params.id,
        station: station._id,
        status: { $in: ["pending", "confirmed"] },
      },
      { status: "cancelled", cancellationReason: reason ?? "Rejected by vendor" },
      { new: true }
    );

    if (!order) {
      return res.status(404).json({ message: "Order not found or cannot be rejected" });
    }

    res.json({ message: "Order rejected", orderId: order._id, status: order.status });
  } catch (err) {
    res.status(500).json({ message: "Failed to reject order" });
  }
});

// ===================== UPDATE STATION FUEL PRICE / AVAILABILITY =====================
// Body: { fuelId: string, pricePerUnit?: number, available?: boolean }
router.patch("/station/fuels", requireAuth, requireVendor, async (req, res) => {
  try {
    const { fuelId, pricePerUnit, available } = req.body;
    if (!fuelId) return res.status(400).json({ message: "fuelId is required" });

    const update: Record<string, unknown> = {};
    if (pricePerUnit !== undefined) update["fuels.$[elem].pricePerUnit"] = pricePerUnit;
    if (available !== undefined) update["fuels.$[elem].available"] = available;

    if (Object.keys(update).length === 0) {
      return res.status(400).json({ message: "Nothing to update" });
    }

    const station = await GasStation.findOneAndUpdate(
      { vendorId: req.userId },
      { $set: update },
      { arrayFilters: [{ "elem.fuel": fuelId }], new: true }
    ).populate("fuels.fuel");

    if (!station) return res.status(404).json({ message: "Station not found" });

    res.json({ message: "Fuel updated", fuels: station.fuels });
  } catch (err) {
    res.status(500).json({ message: "Failed to update fuel" });
  }
});

// ===================== UPDATE STATION INFO =====================
// Body: { name?, isActive?, operatingHours?: { open, close } }
router.patch("/station", requireAuth, requireVendor, async (req, res) => {
  try {
    const { name, isActive, operatingHours } = req.body;
    const update: Record<string, unknown> = {};
    if (name !== undefined) update.name = name;
    if (isActive !== undefined) update.isActive = isActive;
    if (operatingHours?.open !== undefined) update["operatingHours.open"] = operatingHours.open;
    if (operatingHours?.close !== undefined) update["operatingHours.close"] = operatingHours.close;

    if (Object.keys(update).length === 0) {
      return res.status(400).json({ message: "Nothing to update" });
    }

    const station = await GasStation.findOneAndUpdate(
      { vendorId: req.userId },
      { $set: update },
      { new: true }
    );

    if (!station) return res.status(404).json({ message: "Station not found" });

    res.json({ message: "Station updated", station });
  } catch (err) {
    res.status(500).json({ message: "Failed to update station" });
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
        {
          $group: {
            _id: "$status",
            total: { $sum: "$amount" },
          },
        },
      ]),
    ]);

    const totals = { pending: 0, settled: 0 };
    for (const s of summary) {
      if (s._id === "pending") totals.pending = s.total;
      if (s._id === "settled") totals.settled = s.total;
    }

    res.json({
      earnings,
      total,
      page: pageNum,
      pages: Math.ceil(total / limitNum),
      summary: totals,
    });
  } catch (err) {
    res.status(500).json({ message: "Failed to fetch earnings" });
  }
});

export default router;
