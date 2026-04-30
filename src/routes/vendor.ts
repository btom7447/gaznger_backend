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

// ===================== GET VENDOR ORDERS (all stations) =====================
router.get("/orders", requireAuth, requireVendor, async (req, res) => {
  try {
    const stations = await GasStation.find({ vendorId: req.userId }).select("_id").lean();
    if (!stations.length) return res.status(404).json({ message: "No stations found" });

    const stationIds = stations.map((s) => s._id);
    const { status, stationId, page = "1", limit = "20" } = req.query as Record<string, string>;
    const pageNum = Math.max(1, parseInt(page, 10));
    const limitNum = Math.min(50, Math.max(1, parseInt(limit, 10)));
    const skip = (pageNum - 1) * limitNum;

    const filter: Record<string, unknown> = { station: { $in: stationIds } };
    if (status) filter.status = status;
    if (stationId) filter.station = stationId;

    const [orders, total] = await Promise.all([
      Order.find(filter)
        .populate("user", "displayName phone")
        .populate("fuel", "name unit")
        .populate("station", "name")
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
    const { stationId, name, address, state, lga, isActive, autoAcceptOrders, operatingHours, images, location } = req.body;
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
