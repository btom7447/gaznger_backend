import { Router } from "express";
import mongoose from "mongoose";
import multer from "multer";
import cloudinary from "../utils/cloudinary";
import { requireAuth, requireRider } from "../middleware/auth";
import User from "../models/User";
import RiderProfile from "../models/RiderProfile";
import Delivery from "../models/Delivery";
import Order from "../models/Order";
import Earning from "../models/Earning";
import Rating from "../models/Rating";
import GasStation from "../models/Station";
import { notifyUser } from "../utils/notify";
import { emitToUser } from "../socket";
import { createRiderPendingEarning, settleOrderEarnings } from "../utils/earningsUtils";
import Withdrawal from "../models/Withdrawal";
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
    const [profile, user] = await Promise.all([
      RiderProfile.findOne({ user: req.userId }).lean(),
      User.findById(req.userId).select("displayName email phone profileImage").lean(),
    ]);
    if (!profile) return res.status(404).json({ message: "Rider profile not found" });
    res.json({ ...profile, user });
  } catch (err) {
    res.status(500).json({ message: "Failed to fetch rider profile" });
  }
});

// ===================== UPDATE PROFILE PICTURE =====================
router.patch("/profile/picture", requireAuth, requireRider, upload.single("image"), async (req, res) => {
  try {
    if (!req.file?.buffer) return res.status(400).json({ message: "Image required" });
    const url = await uploadToCloudinary(req.file.buffer);
    await User.findByIdAndUpdate(req.userId, { profileImage: url });
    res.json({ profileImage: url });
  } catch (err) {
    res.status(500).json({ message: "Profile picture update failed" });
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
      status: { $in: ["pending", "accepted", "picked_up", "awaiting_confirmation"] },
    })
      .populate({
        path: "order",
        populate: [
          { path: "fuel", select: "name unit" },
          { path: "deliveryAddress" },
          { path: "user", select: "displayName phone profileImage" },
          { path: "station", select: "name address location" },
        ],
      })
      .populate("station", "name address location")
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

    // Create rider pending earning so rider can see preview immediately
    if (delivery.riderEarnings > 0) {
      createRiderPendingEarning(
        req.userId,
        delivery.order.toString(),
        delivery._id.toString(),
        delivery.riderEarnings
      ).catch(() => {});
    }

    // Notify customer via socket + push
    const order = await Order.findById(delivery.order).select("user").lean();
    if (order) {
      const customerId = order.user.toString();
      emitToUser(customerId, "order:update", {
        orderId: delivery.order,
        status: "assigned",
        riderId: req.userId,
      });
      notifyUser(
        customerId,
        "delivery",
        "Rider Assigned",
        "A rider has accepted your order and is heading to the station."
      ).catch(() => {});
    }

    res.json({ message: "Delivery accepted", deliveryId: delivery._id });
  } catch (err) {
    res.status(500).json({ message: "Failed to accept delivery" });
  }
});

// ===================== REJECT DELIVERY =====================
// Rider declines a pending delivery offer dispatched to them.
router.patch("/deliveries/:id/reject", requireAuth, requireRider, async (req, res) => {
  try {
    const delivery = await Delivery.findOneAndUpdate(
      { _id: req.params.id, rider: req.userId, status: "pending" },
      { status: "failed" },
      { new: true }
    );

    if (!delivery) {
      return res.status(404).json({ message: "Delivery not found or already actioned" });
    }

    // The order remains "confirmed" — admin/system can re-dispatch to another rider
    res.json({ message: "Delivery rejected", deliveryId: delivery._id });
  } catch (err) {
    res.status(500).json({ message: "Failed to reject delivery" });
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

    // Transition order to in-transit and notify customer
    const pickupOrder = await Order.findByIdAndUpdate(
      delivery.order,
      { status: "in-transit" },
      { new: true }
    ).select("user").lean();

    if (pickupOrder) {
      emitToUser(pickupOrder.user.toString(), "order:update", {
        orderId: delivery.order,
        status: "in-transit",
      });
    }

    // Notify rider's own screen of the status change
    emitToUser(req.userId, "delivery:update", { deliveryId: delivery._id, status: "picked_up" });

    res.json({ message: "Pickup confirmed", deliveryId: delivery._id });
  } catch (err) {
    res.status(500).json({ message: "Failed to confirm pickup" });
  }
});

// ===================== COMPLETE DELIVERY =====================
// Rider marks delivery as "awaiting_confirmation" — customer must confirm receipt.
router.patch("/deliveries/:id/complete", requireAuth, requireRider, async (req, res) => {
  try {
    const delivery = await Delivery.findOneAndUpdate(
      { _id: req.params.id, rider: req.userId, status: "picked_up" },
      { status: "awaiting_confirmation", deliveryTime: new Date() },
      { new: true }
    );

    if (!delivery) {
      return res.status(404).json({ message: "Delivery not found or not in transit" });
    }

    const order = await Order.findByIdAndUpdate(
      delivery.order,
      { status: "awaiting_confirmation" },
      { new: true }
    );

    if (order) {
      const customerId = order.user.toString();
      emitToUser(customerId, "order:update", { orderId: order._id, status: "awaiting_confirmation" });
      notifyUser(
        customerId,
        "delivery",
        "Confirm Your Delivery",
        "Your rider has arrived! Please confirm you've received your fuel order."
      ).catch(() => {});
    }

    // Notify rider's own screen of the status change
    emitToUser(req.userId, "delivery:update", { deliveryId: delivery._id, status: "awaiting_confirmation" });

    res.json({ message: "Delivery marked — awaiting customer confirmation", deliveryId: delivery._id });
  } catch (err) {
    res.status(500).json({ message: "Failed to complete delivery" });
  }
});

// ===================== DROP DELIVERY =====================
// Rider drops an accepted or in-transit delivery (must provide reason).
router.patch("/deliveries/:id/drop", requireAuth, requireRider, async (req, res) => {
  try {
    const { reason } = req.body;
    if (!reason?.trim()) {
      return res.status(400).json({ message: "A reason is required to drop a delivery" });
    }

    const delivery = await Delivery.findOneAndUpdate(
      { _id: req.params.id, rider: req.userId, status: { $in: ["accepted", "picked_up"] } },
      { status: "dropped", dropReason: reason.trim() },
      { new: true }
    );

    if (!delivery) {
      return res.status(404).json({ message: "Delivery not found or cannot be dropped" });
    }

    // Reset order back to confirmed so dispatch can try again
    const order = await Order.findByIdAndUpdate(
      delivery.order,
      { status: "confirmed", riderId: null, riderAssignedAt: null, dispatchExpiresAt: null },
      { new: true }
    );

    await RiderProfile.findOneAndUpdate(
      { user: req.userId },
      { $inc: { totalDropped: 1 } }
    );

    if (order) {
      const customerId = order.user.toString();
      emitToUser(customerId, "order:update", { orderId: order._id, status: "confirmed" });
      notifyUser(
        customerId,
        "delivery",
        "Rider Dropped Your Order",
        "Your rider was unable to complete the delivery. We're finding a new rider for you."
      ).catch(() => {});
    }

    res.json({ message: "Delivery dropped", deliveryId: delivery._id });
  } catch (err) {
    res.status(500).json({ message: "Failed to drop delivery" });
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
          select: "totalPrice deliveryFee fuelCost status createdAt quantity",
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

// ===================== RIDER PERFORMANCE STATS =====================
router.get("/stats", requireAuth, requireRider, async (req, res) => {
  try {
    const profile = await RiderProfile.findOne({ user: req.userId }).lean();
    if (!profile) return res.status(404).json({ message: "Rider profile not found" });

    const [allDeliveries, droppedCount] = await Promise.all([
      Delivery.find({ rider: req.userId, status: { $in: ["delivered", "dropped", "failed"] } })
        .select("status pickupTime deliveryTime createdAt")
        .lean(),
      Delivery.countDocuments({ rider: req.userId, status: "dropped" }),
    ]);

    const delivered = allDeliveries.filter((d) => d.status === "delivered");
    const totalResponded = allDeliveries.length;
    const acceptanceRate = totalResponded > 0
      ? Math.round((delivered.length / (delivered.length + droppedCount)) * 100)
      : 100;

    // Average delivery time: pickupTime → deliveryTime
    const deliveryTimes = delivered
      .filter((d) => d.pickupTime && d.deliveryTime)
      .map((d) => (new Date(d.deliveryTime!).getTime() - new Date(d.pickupTime!).getTime()) / 60000);
    const avgDeliveryMinutes = deliveryTimes.length > 0
      ? Math.round(deliveryTimes.reduce((a, b) => a + b, 0) / deliveryTimes.length)
      : 0;

    res.json({
      totalDeliveries: profile.totalDeliveries,
      totalDropped: profile.totalDropped ?? droppedCount,
      rating: profile.rating,
      acceptanceRate,
      avgDeliveryMinutes,
    });
  } catch (err) {
    res.status(500).json({ message: "Failed to fetch stats" });
  }
});

// ===================== PAYSTACK BANK LIST =====================
router.get("/banks", requireAuth, async (_req, res) => {
  try {
    const banks = await listBanks();
    res.json({ banks });
  } catch {
    res.status(500).json({ message: "Failed to fetch bank list" });
  }
});

// ===================== PAYSTACK RESOLVE BANK ACCOUNT =====================
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

// ===================== REQUEST PAYOUT (RIDER) =====================
// Implementation lives in utils/withdraw.ts (shared with vendor route).
// Source of truth for balance is now `Wallet.available`, not Earning aggregates.
router.post(
  "/withdraw",
  requireAuth,
  requireRider,
  moneyLimiter,
  idempotencyKey({ enforce: true }),
  async (req, res) => {
    await handleWithdrawRequest(req, res, "rider");
  }
);

// ===================== UPDATE RIDER PROFILE =====================
// Allows updating vehicle details, KYC doc URLs, bankAccount, or profileImage.
// Any vehicle/KYC change resets verificationStatus to "pending".
router.patch("/profile", requireAuth, requireRider, async (req, res) => {
  try {
    const {
      vehiclePlate, vehicleType, vehicleBrand, vehicleColor, vehicleYear,
      nationalIdUrl, driversLicenseUrl, vehiclePapersUrl, vehicleImageUrl, plateImageUrl,
      bankAccount, profileImage,
    } = req.body;
    const profileFields: Record<string, unknown> = {};
    let kycChanged = false;

    if (vehiclePlate) { profileFields.vehiclePlate = vehiclePlate.toUpperCase(); kycChanged = true; }
    if (vehicleType) { profileFields.vehicleType = vehicleType; kycChanged = true; }
    if (vehicleBrand !== undefined) { profileFields.vehicleBrand = vehicleBrand; kycChanged = true; }
    if (vehicleColor !== undefined) { profileFields.vehicleColor = vehicleColor; kycChanged = true; }
    if (vehicleYear !== undefined) { profileFields.vehicleYear = vehicleYear; kycChanged = true; }
    if (nationalIdUrl) { profileFields.nationalIdUrl = nationalIdUrl; kycChanged = true; }
    if (driversLicenseUrl) { profileFields.driversLicenseUrl = driversLicenseUrl; kycChanged = true; }
    if (vehiclePapersUrl) { profileFields.vehiclePapersUrl = vehiclePapersUrl; kycChanged = true; }
    if (vehicleImageUrl) { profileFields.vehicleImageUrl = vehicleImageUrl; kycChanged = true; }
    if (plateImageUrl) { profileFields.plateImageUrl = plateImageUrl; kycChanged = true; }
    if (bankAccount) { profileFields.bankAccount = bankAccount; }

    if (kycChanged) {
      profileFields.isVerified = false;
      profileFields.verificationStatus = "pending";
    }

    if (Object.keys(profileFields).length > 0) {
      const profile = await RiderProfile.findOneAndUpdate(
        { user: req.userId },
        profileFields,
        { new: true }
      );
      if (!profile) return res.status(404).json({ message: "Rider profile not found" });
    }

    // Update profileImage on User model
    if (profileImage) {
      await User.findByIdAndUpdate(req.userId, { profileImage });
    }

    if (Object.keys(profileFields).length === 0 && !profileImage) {
      return res.status(400).json({ message: "No valid fields to update" });
    }

    const [updatedProfile, updatedUser] = await Promise.all([
      RiderProfile.findOne({ user: req.userId }).lean(),
      User.findById(req.userId).select("displayName email phone profileImage").lean(),
    ]);

    res.json({ message: "Profile updated", profile: { ...updatedProfile, user: updatedUser } });
  } catch (err) {
    res.status(500).json({ message: "Failed to update profile" });
  }
});

// ===================== GET RIDER RATINGS =====================
// Returns ratings from customers for orders this rider delivered.
router.get("/ratings", requireAuth, requireRider, async (req, res) => {
  try {
    const { page = "1", limit = "20" } = req.query as Record<string, string>;
    const pageNum = Math.max(1, parseInt(page, 10));
    const limitNum = Math.min(50, Math.max(1, parseInt(limit, 10)));
    const skip = (pageNum - 1) * limitNum;

    // Find order IDs this rider delivered
    const deliveredOrderIds = await Order.find({
      riderId: new mongoose.Types.ObjectId(req.userId),
      status: "delivered",
    }).distinct("_id");

    const [ratings, total] = await Promise.all([
      Rating.find({ order: { $in: deliveredOrderIds } })
        .populate("user", "displayName")
        .populate("order", "_id")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .lean(),
      Rating.countDocuments({ order: { $in: deliveredOrderIds } }),
    ]);

    const avgArr = await Rating.aggregate([
      { $match: { order: { $in: deliveredOrderIds } } },
      { $group: { _id: null, avg: { $avg: "$score" } } },
    ]);
    const averageScore = avgArr[0]?.avg ?? 0;

    res.json({
      ratings,
      total,
      averageScore: Math.round(averageScore * 10) / 10,
      page: pageNum,
      pages: Math.ceil(total / limitNum),
    });
  } catch (err) {
    res.status(500).json({ message: "Failed to fetch ratings" });
  }
});

// ===================== RATE A RIDER (by customer, after delivery) =====================
router.post("/rate/:riderId", requireAuth, async (req, res) => {
  try {
    const { orderId, score } = req.body;
    if (!orderId || !score || score < 1 || score > 5) {
      return res.status(400).json({ message: "orderId and score (1–5) are required" });
    }

    // Verify the customer placed this order
    const order = await Order.findById(orderId).lean();
    if (!order || order.user.toString() !== req.userId) {
      return res.status(403).json({ message: "Forbidden" });
    }
    if (order.status !== "delivered") {
      return res.status(400).json({ message: "Order not yet delivered" });
    }

    // Update the rider's rating average
    const riderProfile = await RiderProfile.findOne({ user: req.params.riderId });
    if (riderProfile) {
      // Simple rolling average using totalDeliveries as denominator
      const n = Math.max(riderProfile.totalDeliveries, 1);
      const currentRating = riderProfile.rating ?? 0;
      riderProfile.rating = parseFloat(((currentRating * (n - 1) + score) / n).toFixed(2));
      await riderProfile.save();
    }

    res.json({ message: "Rider rated" });
  } catch (err) {
    res.status(500).json({ message: "Failed to rate rider" });
  }
});

// ===================== PUBLIC RIDER INFO (for customer tracking screen) =====================
// Returns limited public info about a rider — name, vehicle, rating, phone.
router.get("/public/:riderId", requireAuth, async (req, res) => {
  try {
    const [profile, user] = await Promise.all([
      RiderProfile.findOne({ user: req.params.riderId })
        .select("vehicleType vehiclePlate vehicleBrand rating")
        .lean(),
      User.findById(req.params.riderId)
        .select("displayName phone profileImage")
        .lean(),
    ]);
    if (!profile || !user) return res.status(404).json({ message: "Rider not found" });
    res.json({
      displayName: user.displayName,
      phone: user.phone,
      profileImage: user.profileImage,
      vehicleType: profile.vehicleType,
      vehiclePlate: profile.vehiclePlate,
      rating: profile.rating,
    });
  } catch (err) {
    res.status(500).json({ message: "Failed to fetch rider info" });
  }
});

export default router;
