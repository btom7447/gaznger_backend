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
import {
  emitToUser,
  joinDeliveryRoom,
  leaveDeliveryRoom,
} from "../socket";
import { createRiderPendingEarning, settleOrderEarnings } from "../utils/earningsUtils";
import Withdrawal from "../models/Withdrawal";
import { listBanks, resolveBankAccount } from "../utils/paystack";
import { handleWithdrawRequest } from "../utils/withdraw";
import { moneyLimiter } from "../middleware/moneyLimiter";
import { idempotencyKey } from "../middleware/idempotency";
import {
  ACTIVE_DELIVERY_STATUSES,
  DROPPABLE_DELIVERY_STATUSES,
} from "../_shared";

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
    // Status whitelist comes from `_shared/status.ts` — same set used
    // by the rider:location socket relay. Drift between this list
    // and the relay was the F1 / I2 bug; importing from the shared
    // module makes drift impossible.
    const delivery = await Delivery.findOne({
      rider: req.userId,
      status: { $in: ACTIVE_DELIVERY_STATUSES as unknown as string[] },
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

    // Notify customer via socket + push. Include the rider's
    // customer-safe fields in the payload so the Track screen can
    // populate its rider card without a follow-up GET.
    const order = await Order.findById(delivery.order).select("user").lean();
    if (order) {
      const customerId = order.user.toString();

      // Phase 2 — both parties join the per-delivery room. Subsequent
      // rider:location pings emit directly to the room with no DB
      // lookup. Cleared on terminal status (delivered / dropped /
      // cancelled) by the matching transition handlers.
      joinDeliveryRoom(String(delivery._id), [req.userId!, customerId]);

      const [riderUser, riderProfile] = await Promise.all([
        User.findById(req.userId).select("displayName phone profileImage").lean(),
        RiderProfile.findOne({ user: req.userId })
          .select("vehiclePlate rating")
          .lean(),
      ]);
      const display = riderUser?.displayName ?? "Your rider";
      const [first, ...rest] = display.split(/\s+/);

      emitToUser(customerId, "order:update", {
        orderId: delivery.order,
        status: "assigned",
        riderId: req.userId,
        rider: {
          firstName: first ?? "Rider",
          lastName: rest.join(" "),
          plate: riderProfile?.vehiclePlate,
          rating: riderProfile?.rating,
          phone: riderUser?.phone,
          profileImage: riderUser?.profileImage,
          initials: display
            .split(/\s+/)
            .map((p) => p.charAt(0))
            .join("")
            .slice(0, 2)
            .toUpperCase(),
        },
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
      emitToUser(customerId, "order:update", {
        orderId: order._id,
        status: "awaiting_confirmation",
      });
      // Lock-screen push — copy matches the v3 design's "rider at gate"
      // notification. The legacy rider app collapses the granular
      // arrived/dispensing transitions into awaiting_confirmation, so
      // this is the single notification we have for the on-site phase.
      // When the rider app upgrades and starts emitting `arrived`
      // separately, the equivalent notify in routes/orders.ts handles
      // that path and this one stays as the customer-confirm prompt.
      notifyUser(
        customerId,
        "delivery",
        "Your rider is here 🚪",
        "Step out when ready — confirm receipt in the app once your fuel is in."
      ).catch(() => {});
    }

    // Notify rider's own screen of the status change
    emitToUser(req.userId, "delivery:update", { deliveryId: delivery._id, status: "awaiting_confirmation" });

    res.json({ message: "Delivery marked — awaiting customer confirmation", deliveryId: delivery._id });
  } catch (err) {
    res.status(500).json({ message: "Failed to complete delivery" });
  }
});

// ===================== GRANULAR V3 PHASE TRANSITIONS =====================
/**
 * Six narrow endpoints that drive the v3 granular order pipeline:
 *   PATCH /deliveries/:id/at-plant      assigned     → at_plant
 *   PATCH /deliveries/:id/refilling     at_plant     → refilling
 *   PATCH /deliveries/:id/heading-back  refilling    → returning
 *                                       at_plant     → returning  (LPG-Swap shortcut)
 *   PATCH /deliveries/:id/arrived       returning    → arrived
 *   PATCH /deliveries/:id/dispensing    arrived      → dispensing
 *   PATCH /deliveries/:id/finalise      dispensing   → awaiting_confirmation
 *                                       arrived      → awaiting_confirmation (swap shortcut)
 *
 * Each transition:
 *   1. Validates the rider owns the delivery + the previous status.
 *   2. Updates the Order status (the canonical timeline customers see).
 *   3. Emits `order:update` to the customer's socket room.
 *   4. Emits `delivery:update` to the rider's own room (so the
 *      rider screen reflects the new state on the next render).
 *
 * The legacy `/pickup` + `/complete` endpoints stay in place as
 * compatibility shims; older rider builds keep working alongside
 * the new granular flow.
 */
/**
 * Apply a rider-driven status transition atomically.
 *
 * Phase 9 — concurrency model:
 *
 *   The `from` status filter on findOneAndUpdate IS the concurrency
 *   guard. Two concurrent calls with the same `(deliveryId, slug)`
 *   pair: the first one matches, flips status, returns the updated
 *   doc; the second one's filter no longer matches the (already-
 *   flipped) status, returns null, gets a 409. No need for a Redis-
 *   backed idempotency cache — Mongo's atomic findOneAndUpdate is
 *   strong enough for this shape of operation.
 *
 *   Where this is NOT enough: operations that span MULTIPLE collection
 *   writes (e.g. confirm-delivery, which writes Order + Delivery +
 *   Earnings + RiderProfile + Notifications). Those need a Mongo
 *   transaction OR an idempotency-key cache so a retry doesn't
 *   re-credit earnings. See orders.ts:/confirm-delivery for the
 *   spot fix; broader transactional support is queued behind a
 *   replica-set-required infra setup.
 */
async function applyRiderTransition(
  riderId: string,
  deliveryId: string | string[] | undefined,
  fromDeliveryStatuses: string[],
  toDeliveryStatus: string,
  toOrderStatus: string,
  successMessage: string,
  res: import("express").Response
) {
  try {
    // Capture the prior delivery status BEFORE the write so we can
    // roll back if the matching Order update fails. Phase 5
    // duality-drift hardening: Delivery.status and Order.status
    // must end up in lockstep, or stay in lockstep (both at the
    // prior value). The reconcileStatusDuality script catches any
    // drift that slips through, but the rollback here prevents most.
    const prior = await Delivery.findOne({
      _id: deliveryId,
      rider: riderId,
    })
      .select("status")
      .lean();

    const delivery = await Delivery.findOneAndUpdate(
      { _id: deliveryId, rider: riderId, status: { $in: fromDeliveryStatuses } },
      { status: toDeliveryStatus },
      { new: true }
    );
    if (!delivery) {
      return res.status(409).json({
        message: `Delivery not in expected state (need one of: ${fromDeliveryStatuses.join(", ")}).`,
      });
    }

    let order: { user: { toString(): string } } | null = null;
    try {
      order = await Order.findByIdAndUpdate(
        delivery.order,
        { status: toOrderStatus },
        { new: true }
      ).select("user").lean();
    } catch (orderErr) {
      // Rollback the Delivery write so the two stay in lockstep.
      // Without this, customer sees old status while rider sees new.
      if (prior?.status) {
        await Delivery.updateOne(
          { _id: delivery._id },
          { status: prior.status }
        ).catch(() => {});
      }
      throw orderErr;
    }

    if (order) {
      const customerId = order.user.toString();
      emitToUser(customerId, "order:update", {
        orderId: delivery.order,
        status: toOrderStatus,
      });

      // Phase 8 — push parity for customer-facing transitions.
      // High-importance state changes that the customer needs to
      // act on (or that visibly change their screen) get a push;
      // intermediate moves (at_plant / refilling / returning) are
      // too noisy and skip.
      const pushPayload = pushForCustomer(toOrderStatus, String(delivery.order));
      if (pushPayload) {
        notifyUser(
          customerId,
          pushPayload.kind,
          pushPayload.title,
          pushPayload.body
        ).catch(() => {});
      }
    }
    emitToUser(riderId, "delivery:update", {
      deliveryId: delivery._id,
      status: toDeliveryStatus,
    });

    return res.json({ message: successMessage, deliveryId: delivery._id });
  } catch (err) {
    return res.status(500).json({ message: "Transition failed" });
  }
}

/**
 * Customer-facing push gating.
 *
 * Returns a push payload for transitions that warrant notifying the
 * customer on a locked phone, or null for intermediate states that
 * don't. The `data` field would carry deep-link info — the existing
 * `notifyUser` signature doesn't yet accept it; that lands when the
 * notification utility gets extended to pass the orderId through to
 * APNs/FCM payload data so the app can deep-link on tap.
 */
type PushKind = import("../models/Notification").NotificationType;
function pushForCustomer(
  toOrderStatus: string,
  _orderId: string
): { kind: PushKind; title: string; body: string } | null {
  switch (toOrderStatus) {
    case "arrived":
      return {
        kind: "delivery",
        title: "Rider arrived",
        body: "Your rider is at your gate. Open the app to confirm.",
      };
    case "dispensing":
      return {
        kind: "delivery",
        title: "Dispensing now",
        body: "Your rider has started filling your order.",
      };
    case "awaiting_confirmation":
      return {
        kind: "delivery",
        title: "Confirm your delivery",
        body: "Your rider has marked the order delivered. Tap to confirm.",
      };
    // at_plant / refilling / returning — too noisy for push
    default:
      return null;
  }
}

// At plant — rider has reached the pickup station.
router.patch("/deliveries/:id/at-plant", requireAuth, requireRider, async (req, res) => {
  // Delivery model uses `accepted` for "rider en route to station"
  // in the legacy flow. We accept either `accepted` or `picked_up`
  // here so a rider that already pressed the legacy "pickup" button
  // can still flip back into the granular flow without getting stuck.
  await applyRiderTransition(
    req.userId,
    req.params.id,
    ["accepted", "picked_up"],
    "at_plant",
    "at_plant",
    "Marked at plant",
    res
  );
});

// Refilling — pump operator filling the order. Liquid only; LPG-Swap
// orders skip directly from at_plant → returning via /heading-back.
router.patch("/deliveries/:id/refilling", requireAuth, requireRider, async (req, res) => {
  await applyRiderTransition(
    req.userId,
    req.params.id,
    ["at_plant"],
    "refilling",
    "refilling",
    "Refilling started",
    res
  );
});

// Heading back — loaded, on the way to the customer. Accepts either
// `refilling` (liquid) or `at_plant` (LPG-Swap shortcut).
router.patch("/deliveries/:id/heading-back", requireAuth, requireRider, async (req, res) => {
  await applyRiderTransition(
    req.userId,
    req.params.id,
    ["refilling", "at_plant"],
    "returning",
    "returning",
    "Heading back",
    res
  );
});

// Arrived — pulled up at the customer's gate. Customer-side this
// flips Track to `almost-there` and fires the lock-screen push.
router.patch("/deliveries/:id/arrived", requireAuth, requireRider, async (req, res) => {
  await applyRiderTransition(
    req.userId,
    req.params.id,
    ["returning"],
    "arrived",
    "arrived",
    "Arrived",
    res
  );
});

// Dispensing — started pumping at the customer's tank. Liquid only;
// LPG-Swap goes straight from arrived → finalise. The rider-side
// emit also drives the `dispense:progress` events while pumping
// (those carry a `litres` payload — see /dispense-progress below).
router.patch("/deliveries/:id/dispensing", requireAuth, requireRider, async (req, res) => {
  await applyRiderTransition(
    req.userId,
    req.params.id,
    ["arrived"],
    "dispensing",
    "dispensing",
    "Dispensing started",
    res
  );
});

// Finalise — done, customer must confirm. Accepts either `dispensing`
// (liquid) or `arrived` (LPG-Swap shortcut).
router.patch("/deliveries/:id/finalise", requireAuth, requireRider, async (req, res) => {
  try {
    const delivery = await Delivery.findOneAndUpdate(
      {
        _id: req.params.id,
        rider: req.userId,
        status: { $in: ["dispensing", "arrived"] },
      },
      { status: "awaiting_confirmation", deliveryTime: new Date() },
      { new: true }
    );
    if (!delivery) {
      return res
        .status(409)
        .json({ message: "Delivery not in dispensing or arrived state" });
    }

    const order = await Order.findByIdAndUpdate(
      delivery.order,
      { status: "awaiting_confirmation" },
      { new: true }
    );

    if (order) {
      const customerId = order.user.toString();
      emitToUser(customerId, "order:update", {
        orderId: order._id,
        status: "awaiting_confirmation",
      });
      notifyUser(
        customerId,
        "delivery",
        "Confirm your delivery",
        "Tap to confirm you've received your fuel."
      ).catch(() => {});
    }
    emitToUser(req.userId, "delivery:update", {
      deliveryId: delivery._id,
      status: "awaiting_confirmation",
    });

    res.json({
      message: "Awaiting customer confirmation",
      deliveryId: delivery._id,
    });
  } catch (err) {
    res.status(500).json({ message: "Failed to finalise delivery" });
  }
});

/**
 * Dispense progress ping. Called by the rider app while pumping —
 * accepts a single `litres` value (cumulative, not delta) which
 * drives the customer's Arrival screen DispenseRing. Idempotent;
 * rider can call this every 200ms without burning the server.
 */
router.post(
  "/deliveries/:id/dispense-progress",
  requireAuth,
  requireRider,
  async (req, res) => {
    try {
      const { litres } = req.body as { litres?: number };
      if (typeof litres !== "number" || !Number.isFinite(litres) || litres < 0) {
        return res.status(400).json({ message: "litres must be >= 0" });
      }
      const delivery = await Delivery.findOne({
        _id: req.params.id,
        rider: req.userId,
      })
        .select("order status")
        .lean();
      if (!delivery) {
        return res.status(404).json({ message: "Delivery not found" });
      }
      if (delivery.status !== "dispensing") {
        return res.status(409).json({
          message: "Delivery is not in dispensing state",
        });
      }
      const order = await Order.findById(delivery.order)
        .select("user")
        .lean();
      if (order) {
        emitToUser(order.user.toString(), "dispense:progress", {
          orderId: delivery.order,
          litres,
        });
      }
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ message: "Failed to push dispense progress" });
    }
  }
);

// ===================== DROP DELIVERY =====================
// Rider drops an accepted or in-transit delivery (must provide reason).
router.patch("/deliveries/:id/drop", requireAuth, requireRider, async (req, res) => {
  try {
    const { reason } = req.body;
    if (!reason?.trim()) {
      return res.status(400).json({ message: "A reason is required to drop a delivery" });
    }

    // Drop is allowed from any in-flight state — see
    // DROPPABLE_DELIVERY_STATUSES in `_shared/status.ts`. A rider can
    // legitimately need to abandon at any point (bike breakdown,
    // plant out of stock), so we keep the drop path open through the
    // granular pipeline.
    const delivery = await Delivery.findOneAndUpdate(
      {
        _id: req.params.id,
        rider: req.userId,
        status: { $in: DROPPABLE_DELIVERY_STATUSES as unknown as string[] },
      },
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

    // Tear down the delivery room — neither rider nor customer
    // should keep receiving room emits for a dropped job. Customer
    // re-joins automatically when a new rider accepts.
    leaveDeliveryRoom(String(delivery._id));

    res.json({ message: "Delivery dropped", deliveryId: delivery._id });
  } catch (err) {
    res.status(500).json({ message: "Failed to drop delivery" });
  }
});

// ===================== DISPENSE PROGRESS =====================
// Rider streams pump progress while filling at the customer's gate.
// Customer's Arrival screen subscribes to `dispense:progress` to drive
// the dispense ring. No DB write — this is purely a passthrough.
//
// Body: { litres: number }   (cumulative volume dispensed)
router.post(
  "/orders/:orderId/dispense",
  requireAuth,
  requireRider,
  async (req, res) => {
    try {
      const { litres } = req.body ?? {};
      if (typeof litres !== "number" || !Number.isFinite(litres) || litres < 0) {
        return res.status(400).json({ message: "litres must be a non-negative number" });
      }

      const order = await Order.findById(req.params.orderId)
        .select("user riderId quantity")
        .lean();
      if (!order) return res.status(404).json({ message: "Order not found" });
      if (order.riderId?.toString() !== req.userId) {
        return res.status(403).json({ message: "Forbidden" });
      }

      // Cap at order quantity so over-pumping bugs don't push the ring
      // past 100% on the customer's screen.
      const capped = Math.min(litres, (order as any).quantity ?? litres);
      emitToUser(order.user.toString(), "dispense:progress", {
        orderId: order._id,
        litres: capped,
      });

      res.json({ ok: true });
    } catch (err) {
      console.error("[rider/dispense]", err);
      res.status(500).json({ message: "Failed to record dispense progress" });
    }
  }
);

// ===================== LPG WEIGH-IN =====================
// LPG-Swap step: rider weighs the customer's empty cylinder + the
// freshly-filled one at the station. Customer's Handoff screen renders
// the weight verification card from this payload.
//
// On submit:
//   1. Persist weighIn { emptyKg, fullKg, netKg, weighedAt } on Order.
//   2. Recompute totalCharged = min(estimated, weighedActualPrice). Per
//      spec: customer pays the LOWER of the two.
//   3. Emit `order:update` with the updated weighIn + totalCharged.
//
// Body: { emptyKg: number, fullKg: number }
router.post(
  "/orders/:orderId/weigh-in",
  requireAuth,
  requireRider,
  async (req, res) => {
    try {
      const { emptyKg, fullKg } = req.body ?? {};
      if (
        typeof emptyKg !== "number" ||
        typeof fullKg !== "number" ||
        !Number.isFinite(emptyKg) ||
        !Number.isFinite(fullKg) ||
        emptyKg < 0 ||
        fullKg <= emptyKg
      ) {
        return res.status(400).json({
          message: "emptyKg + fullKg required, fullKg must exceed emptyKg",
        });
      }

      const order = await Order.findById(req.params.orderId);
      if (!order) return res.status(404).json({ message: "Order not found" });
      if (order.riderId?.toString() !== req.userId) {
        return res.status(403).json({ message: "Forbidden" });
      }
      if ((order as any).deliveryType !== "cylinder_swap") {
        return res
          .status(400)
          .json({ message: "Weigh-in only applies to cylinder swap orders" });
      }

      const netKg = Math.round((fullKg - emptyKg) * 100) / 100;
      order.weighIn = {
        emptyKg,
        fullKg,
        netKg,
        weighedAt: new Date(),
      };

      // Recompute totalCharged = min(estimate, weighed actual).
      // Per-kg price already locked on the station fuels[] entry.
      const station = await (await import("../models/Station")).default
        .findById(order.station)
        .select("fuels")
        .lean();
      const fuel = await (await import("../models/FuelType")).default
        .findById(order.fuel)
        .select("name")
        .lean();
      const stationEntry = (station as any)?.fuels?.find(
        (f: any) => f.fuel.toString() === order.fuel.toString()
      );
      const pricePerKg = stationEntry?.pricePerUnit ?? 0;
      const weighedFuelCost = Math.round(netKg * pricePerKg);
      // delivery fee was already locked at order create.
      const weighedTotal = weighedFuelCost + order.deliveryFee;
      // Keep the lower of the estimate vs the actual.
      order.totalCharged = Math.min(order.totalPrice, weighedTotal);
      void fuel; // touched to satisfy unused-var when uncommented later
      await order.save();

      emitToUser(order.user.toString(), "order:update", {
        orderId: order._id,
        weighIn: order.weighIn,
        totalCharged: order.totalCharged,
      });

      res.json({
        ok: true,
        weighIn: order.weighIn,
        totalCharged: order.totalCharged,
      });
    } catch (err) {
      console.error("[rider/weigh-in]", err);
      res.status(500).json({ message: "Failed to record weigh-in" });
    }
  }
);

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
