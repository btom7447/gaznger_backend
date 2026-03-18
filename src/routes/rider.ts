import { Router } from "express";
import mongoose from "mongoose";
import { requireAuth, requireRider } from "../middleware/auth";
import User from "../models/User";
import RiderProfile from "../models/RiderProfile";
import Delivery from "../models/Delivery";
import Order from "../models/Order";
import Earning from "../models/Earning";
import GasStation from "../models/Station";
import { notifyUser } from "../utils/notify";

const router = Router();

// ===================== RIDER ONBOARDING SETUP =====================
// Called at the end of the 3-step onboarding wizard.
// Creates the RiderProfile document and marks user as onboarded.
router.post("/setup", requireAuth, requireRider, async (req, res) => {
  try {
    const { vehicleType, vehiclePlate, bankAccount } = req.body;

    if (!vehicleType || !vehiclePlate) {
      return res.status(400).json({ message: "vehicleType and vehiclePlate are required" });
    }

    // Prevent double-setup
    const existing = await RiderProfile.findOne({ user: req.userId });
    if (existing) {
      return res.status(409).json({ message: "Rider profile already exists" });
    }

    const profile = await RiderProfile.create({
      user: req.userId,
      vehicleType,
      vehiclePlate: vehiclePlate.toUpperCase(),
      isAvailable: false,
      isVerified: false,
      bankAccount: bankAccount ?? {},
    });

    await User.findByIdAndUpdate(req.userId, { isOnboarded: true });

    res.status(201).json({ message: "Rider profile created", profile });
  } catch (err) {
    res.status(500).json({ message: "Rider setup failed" });
  }
});

// ===================== GET RIDER PROFILE =====================
router.get("/profile", requireAuth, requireRider, async (req, res) => {
  try {
    const profile = await RiderProfile.findOne({ user: req.userId }).lean();
    if (!profile) return res.status(404).json({ message: "Rider profile not found" });
    res.json(profile);
  } catch (err) {
    res.status(500).json({ message: "Failed to fetch rider profile" });
  }
});

// ===================== TOGGLE AVAILABILITY =====================
router.patch("/availability", requireAuth, requireRider, async (req, res) => {
  try {
    const { isAvailable } = req.body;
    if (typeof isAvailable !== "boolean") {
      return res.status(400).json({ message: "isAvailable (boolean) is required" });
    }
    const profile = await RiderProfile.findOneAndUpdate(
      { user: req.userId },
      { isAvailable },
      { new: true }
    );
    if (!profile) return res.status(404).json({ message: "Rider profile not found" });
    res.json({ isAvailable: profile.isAvailable });
  } catch (err) {
    res.status(500).json({ message: "Failed to update availability" });
  }
});

// ===================== UPDATE CURRENT LOCATION =====================
router.patch("/location", requireAuth, requireRider, async (req, res) => {
  try {
    const { lat, lng } = req.body;
    if (typeof lat !== "number" || typeof lng !== "number") {
      return res.status(400).json({ message: "lat and lng (numbers) are required" });
    }
    await RiderProfile.findOneAndUpdate(
      { user: req.userId },
      { currentLocation: { lat, lng } }
    );
    res.json({ message: "Location updated" });
  } catch (err) {
    res.status(500).json({ message: "Failed to update location" });
  }
});

// ===================== GET ACTIVE DELIVERY =====================
// Returns the rider's current in-progress delivery (accepted or picked_up).
router.get("/active", requireAuth, requireRider, async (req, res) => {
  try {
    const delivery = await Delivery.findOne({
      rider: req.userId,
      status: { $in: ["pending", "accepted", "picked_up"] },
    })
      .populate({
        path: "order",
        populate: [
          { path: "fuel", select: "name unit" },
          { path: "deliveryAddress" },
          { path: "user", select: "displayName phone" },
        ],
      })
      .populate("station", "name address")
      .lean();

    res.json({ delivery: delivery ?? null });
  } catch (err) {
    res.status(500).json({ message: "Failed to fetch active delivery" });
  }
});

// ===================== ACCEPT DELIVERY =====================
// Rider accepts a dispatched delivery offer.
// Delivery must be status "pending" and assigned to this rider.
router.patch("/deliveries/:id/accept", requireAuth, requireRider, async (req, res) => {
  try {
    const delivery = await Delivery.findOneAndUpdate(
      { _id: req.params.id, rider: req.userId, status: "pending" },
      { status: "accepted" },
      { new: true }
    );

    if (!delivery) {
      return res.status(404).json({ message: "Delivery not found or already actioned" });
    }

    // Mark order as assigned
    await Order.findByIdAndUpdate(delivery.order, {
      status: "assigned",
      riderId: req.userId,
      riderAssignedAt: new Date(),
    });

    // Cancel all other pending Delivery records for the same order (broadcast losers)
    await Delivery.deleteMany({
      order: delivery.order,
      _id: { $ne: delivery._id },
      status: "pending",
    });

    // Notify customer
    const order = await Order.findById(delivery.order).select("user").lean();
    if (order) {
      await notifyUser(
        order.user.toString(),
        "delivery",
        "Rider Assigned",
        "A rider has accepted your order and is heading to the station."
      );
    }

    res.json({ message: "Delivery accepted", deliveryId: delivery._id });
  } catch (err) {
    res.status(500).json({ message: "Failed to accept delivery" });
  }
});

// ===================== MARK PICKUP =====================
// Rider has picked up the fuel from the station.
router.patch("/deliveries/:id/pickup", requireAuth, requireRider, async (req, res) => {
  try {
    const delivery = await Delivery.findOneAndUpdate(
      { _id: req.params.id, rider: req.userId, status: "accepted" },
      { status: "picked_up", pickupTime: new Date() },
      { new: true }
    );

    if (!delivery) {
      return res.status(404).json({ message: "Delivery not found or not in accepted state" });
    }

    // Transition order to in-transit
    await Order.findByIdAndUpdate(delivery.order, { status: "in-transit" });

    res.json({ message: "Pickup confirmed", deliveryId: delivery._id });
  } catch (err) {
    res.status(500).json({ message: "Failed to confirm pickup" });
  }
});

// ===================== COMPLETE DELIVERY =====================
// Rider marks delivery as complete.
router.patch("/deliveries/:id/complete", requireAuth, requireRider, async (req, res) => {
  try {
    const delivery = await Delivery.findOneAndUpdate(
      { _id: req.params.id, rider: req.userId, status: "picked_up" },
      { status: "delivered", deliveryTime: new Date() },
      { new: true }
    );

    if (!delivery) {
      return res.status(404).json({ message: "Delivery not found or not in transit" });
    }

    const completedOrder = await Order.findByIdAndUpdate(
      delivery.order,
      { status: "delivered" },
      { new: true }
    );

    // Record rider earning (pending settlement)
    if (delivery.riderEarnings > 0) {
      await Earning.create({
        user: req.userId,
        role: "rider",
        order: delivery.order,
        delivery: delivery._id,
        amount: delivery.riderEarnings,
        type: "delivery_fee",
        status: "pending",
      });
    }

    // Record vendor earning from fuel sale
    if (completedOrder && completedOrder.fuelCost > 0) {
      const station = await GasStation.findById(completedOrder.station)
        .select("vendorId")
        .lean();
      if (station?.vendorId) {
        const platformFuelComm = Number(process.env.PLATFORM_FUEL_COMMISSION) || 10;
        const vendorAmount = Math.round(
          completedOrder.fuelCost * (1 - platformFuelComm / 100)
        );
        await Earning.create({
          user: station.vendorId,
          role: "vendor",
          order: delivery.order,
          delivery: delivery._id,
          amount: vendorAmount,
          type: "fuel_sale",
          status: "pending",
        });
      }
    }

    // Increment totalDeliveries on rider profile
    await RiderProfile.findOneAndUpdate(
      { user: req.userId },
      { $inc: { totalDeliveries: 1 } }
    );

    // Notify customer
    if (completedOrder) {
      await notifyUser(
        completedOrder.user.toString(),
        "delivered",
        "Fuel Delivered!",
        "Your fuel order has been delivered. Enjoy!"
      );
    }

    res.json({ message: "Delivery completed", deliveryId: delivery._id });
  } catch (err) {
    res.status(500).json({ message: "Failed to complete delivery" });
  }
});

// ===================== GET DELIVERY HISTORY =====================
router.get("/deliveries", requireAuth, requireRider, async (req, res) => {
  try {
    const { page = "1", limit = "20" } = req.query as Record<string, string>;
    const pageNum = Math.max(1, parseInt(page, 10));
    const limitNum = Math.min(50, Math.max(1, parseInt(limit, 10)));
    const skip = (pageNum - 1) * limitNum;

    const [deliveries, total] = await Promise.all([
      Delivery.find({ rider: req.userId })
        .populate({
          path: "order",
          select: "totalPrice deliveryFee fuelCost status createdAt",
          populate: { path: "fuel", select: "name unit" },
        })
        .populate("station", "name address state")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .lean(),
      Delivery.countDocuments({ rider: req.userId }),
    ]);

    res.json({ deliveries, total, page: pageNum, pages: Math.ceil(total / limitNum) });
  } catch (err) {
    res.status(500).json({ message: "Failed to fetch delivery history" });
  }
});

// ===================== GET RIDER EARNINGS =====================
router.get("/earnings", requireAuth, requireRider, async (req, res) => {
  try {
    const { page = "1", limit = "20" } = req.query as Record<string, string>;
    const pageNum = Math.max(1, parseInt(page, 10));
    const limitNum = Math.min(50, Math.max(1, parseInt(limit, 10)));
    const skip = (pageNum - 1) * limitNum;

    const [earnings, total, summary] = await Promise.all([
      Earning.find({ user: req.userId, role: "rider" })
        .populate("order", "totalPrice deliveryFee createdAt")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .lean(),
      Earning.countDocuments({ user: req.userId, role: "rider" }),
      Earning.aggregate([
        { $match: { user: new mongoose.Types.ObjectId(req.userId), role: "rider" } },
        { $group: { _id: "$status", total: { $sum: "$amount" } } },
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
