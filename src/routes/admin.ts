import { Router } from "express";
import { validate } from "../middleware/validate";
import { requireAuth, requireAdmin } from "../middleware/auth";
import User from "../models/User";
import GasStation from "../models/Station";
import Order from "../models/Order";
import RiderProfile from "../models/RiderProfile";
import Earning from "../models/Earning";
import Delivery from "../models/Delivery";
import { adminVerificationDecisionSchema } from "../validators/auth.validators";
import { disconnectUserSockets, emitToUser } from "../socket";
import { notifyUser } from "../utils/notify";
import { writeAudit } from "../utils/audit";
import { safeRegexSearch } from "../utils/safeRegex";
import { bumpTokenVersion } from "../utils/tokenVersion";

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
      // P2-MF (audit run 4): flatten to a plain number to match the
      // admin-web `StatsResponse.stations: number` shape. Pre-fix
      // the server returned `{ total: stationCount }` which would
      // have rendered as "[object Object]" / NaN if the dashboard
      // ever displayed it (currently unrendered, but a foot-gun).
      stations: stationCount,
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
    // SEC-P1 (audit run 5): raw user input into $regex was a ReDoS +
    // regex-injection vector — `?search=(.*a){25}` triggered
    // catastrophic backtracking across the entire User collection.
    // safeRegexSearch length-caps + escapes the input.
    const searchPattern = safeRegexSearch(search);
    if (searchPattern) {
      filter.$or = [
        { displayName: { $regex: searchPattern, $options: "i" } },
        { email: { $regex: searchPattern, $options: "i" } },
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

    // Riders need a KYC pill on the table; vendors already carry
    // `vendorVerification` inline on the User doc but riders carry it
    // on RiderProfile. Batch-fetch the matching RiderProfiles and
    // attach a `riderVerificationStatus` field per rider row so the
    // admin table can render both pills uniformly without N+1 queries.
    const riderIds = users
      .filter((u) => u.role === "rider")
      .map((u) => u._id);
    if (riderIds.length > 0) {
      const profiles = await RiderProfile.find({ user: { $in: riderIds } })
        .select("user verificationStatus isVerified")
        .lean();
      const byUser = new Map(profiles.map((p) => [String(p.user), p]));
      for (const u of users as any[]) {
        if (u.role === "rider") {
          const p = byUser.get(String(u._id));
          u.riderVerificationStatus =
            p?.verificationStatus ??
            (p?.isVerified ? "verified" : "pending");
        }
      }
    }

    res.json({ users, total, page: pageNum, pages: Math.ceil(total / limitNum) });
  } catch (err) {
    res.status(500).json({ message: "Failed to fetch users" });
  }
});

// ===================== UPDATE USER ROLE =====================
// SECURITY P0 (audit run 5): this route mints admins. Pre-fix it
// wrote no AuditLog row — a compromised admin token could promote
// arbitrary users to admin and the change would be invisible to ops
// forensics. Now requires `reason`, writes audit (before/after diff),
// and explicitly refuses to promote to "admin" via this endpoint —
// admin promotion needs a dedicated co-sign / PIN step-up path that
// hasn't shipped yet, so we fail closed.
router.patch("/users/:id/role", async (req, res) => {
  try {
    const { role, reason } = req.body as { role?: string; reason?: string };
    const validRoles = ["customer", "vendor", "rider"];
    if (!role || !validRoles.includes(role)) {
      return res.status(400).json({
        message:
          "Invalid role. Allowed: customer, vendor, rider. Admin promotion " +
          "requires the dedicated /users/:id/promote-to-admin endpoint (not yet shipped).",
      });
    }
    if (!reason || reason.trim().length < 4) {
      return res.status(400).json({
        message: "reason is required (min 4 chars) for any role change",
      });
    }

    const before = await User.findById(req.params.id).select("role").lean();
    if (!before) return res.status(404).json({ message: "User not found" });
    if (before.role === "admin") {
      return res.status(403).json({
        message:
          "Cannot demote an existing admin via this endpoint. Use a dedicated /demote-admin flow with co-sign.",
      });
    }
    if (before.role === role) {
      return res.status(409).json({ message: `User is already a ${role}` });
    }

    const user = await User.findByIdAndUpdate(
      req.params.id,
      { role },
      { new: true }
    ).select("-passwordHash -pinHash -otpCode -otpExpiresAt -deviceTokens -lastPaystackAuth");

    if (!user) return res.status(404).json({ message: "User not found" });

    await writeAudit({
      actor: req.userId!,
      action: "user.role_change",
      targetKind: "User",
      target: String(user._id),
      before: { role: before.role },
      after: { role: user.role },
      reason,
      ip: req.ip,
    });

    // SEC-P1: bump tokenVersion so the user's next request forces a
    // re-login. The new role + UI gates kick in immediately instead
    // of waiting up to 15 min for the access token to expire.
    await bumpTokenVersion(String(user._id));

    res.json({ message: "Role updated", user });
  } catch (err) {
    console.error("[admin/users/role]", err);
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
        // Populate the assigned rider so the admin table can show
        // "who is delivering this" without a follow-up GET. Refund
        // status fields ride along automatically because they're part
        // of the Order schema (no select-exclude needed).
        .populate("riderId", "displayName phone profileImage")
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

// ===================== FORCE RIDER OFFLINE =====================
/**
 * POST /api/admin/riders/:userId/force-offline { reason?, note? }
 *
 * Admin-driven hard offline. Flips `RiderProfile.isAvailable: false`
 * and pushes `rider:force-offline` to the rider's socket room so the
 * v7 mobile build can route to the dedicated force-offline screen
 * (brief §5A — the rider needs to see why the Go-online switch
 * stopped working). Note that `:userId` is the User id, not the
 * RiderProfile id — matches the rest of the rider socket addressing.
 *
 * `reason` is plumbed straight into the mobile screen's variant
 * selector: "location" / "background" / "admin" (default).
 * `note` is shown to the rider verbatim — keep it short.
 */
router.post("/riders/:userId/force-offline", async (req, res) => {
  try {
    const { reason, note } = req.body as { reason?: string; note?: string };
    const safeReason =
      reason === "location" || reason === "background" || reason === "admin"
        ? reason
        : "admin";

    const profile = await RiderProfile.findOneAndUpdate(
      { user: req.params.userId },
      { isAvailable: false },
      { new: true },
    );
    if (!profile) {
      return res.status(404).json({ message: "Rider profile not found" });
    }

    // Push to the rider's socket room so the (rider)/_layout listener
    // routes to the force-offline screen with the correct variant.
    emitToUser(req.params.userId as string, "rider:force-offline", {
      reason: safeReason,
      note: note ?? null,
    });

    // P1-6 (audit run 5): pair the socket emit with a push so a rider
    // on the move with the app backgrounded actually sees the alert
    // (OS-level lock-screen notification). Without this, every
    // backgrounded rider misses the force-offline event entirely.
    await notifyUser(
      req.params.userId as string,
      "account",
      "You've been taken offline",
      note?.trim() || "Admin has paused your account. Open the app for details.",
    ).catch(() => {});

    // P1: audit log this privileged action — earnings-capacity change.
    await writeAudit({
      actor: req.userId!,
      action: "rider.force_offline",
      targetKind: "User",
      target: req.params.userId as string,
      after: { isAvailable: false, reason: safeReason, note: note ?? null },
      reason: note,
      ip: req.ip,
    });

    res.json({
      message: "Rider taken offline",
      userId: req.params.userId,
      reason: safeReason,
    });
  } catch (err) {
    res.status(500).json({ message: "Failed to force rider offline" });
  }
});

// ===================== FORCE RIDER ONLINE (undo) =====================
/**
 * POST /api/admin/riders/:userId/force-online
 *
 * Undo for the admin force-offline. Flips `RiderProfile.isAvailable: true`
 * and emits `rider:force-online` so the rider's app dismisses the
 * force-offline screen if it's still up. Rider still needs to be
 * verified + have a current location ping to receive new offers — this
 * is purely the admin "let them back in" toggle.
 */
router.post("/riders/:userId/force-online", async (req, res) => {
  try {
    const profile = await RiderProfile.findOneAndUpdate(
      { user: req.params.userId },
      { isAvailable: true },
      { new: true },
    );
    if (!profile) {
      return res.status(404).json({ message: "Rider profile not found" });
    }
    emitToUser(req.params.userId as string, "rider:force-online", {
      at: new Date(),
    });
    // P1-6: push parity so a backgrounded rider sees the reinstatement.
    await notifyUser(
      req.params.userId as string,
      "account",
      "You're back online",
      "Admin has re-enabled your account. You can accept deliveries again.",
    ).catch(() => {});

    // P1: audit log mirror of force_offline.
    await writeAudit({
      actor: req.userId!,
      action: "rider.force_online",
      targetKind: "User",
      target: req.params.userId as string,
      after: { isAvailable: true },
      ip: req.ip,
    });
    res.json({
      message: "Rider re-enabled",
      userId: req.params.userId,
    });
  } catch (err) {
    res.status(500).json({ message: "Failed to re-enable rider" });
  }
});

// ===================== VERIFICATION DECISION (v4) =====================
/**
 * Approve / reject a rider or vendor's submitted verification. Replaces
 * the legacy `riders/:id/verify` toggle for v4 — uses the unified
 * User.verificationStatus field. Emits `verification:status` to the
 * user's socket room so the mobile pending-lobby flips in real-time.
 */
router.patch(
  "/users/:id/verification",
  validate(adminVerificationDecisionSchema),
  async (req, res) => {
    try {
      const { status, reason } = req.body as {
        status: "approved" | "rejected";
        reason?: string;
      };

      const user = await User.findById(req.params.id);
      if (!user) return res.status(404).json({ message: "User not found" });
      if (user.role !== "rider" && user.role !== "vendor") {
        return res
          .status(400)
          .json({ message: "Verification only applies to rider/vendor." });
      }

      user.verificationStatus = status;
      user.verificationReason = reason;
      user.verificationReviewedAt = new Date();
      user.verificationReviewedBy = req.userId as never;

      // MODEL-FIELDS P0-5 (audit run 4): mirror-write the legacy
      // per-role fields so existing mobile readers (vendor kyc.tsx
      // reads `vendorVerification.note`; rider verification-blocker
      // reads `RiderProfile.verificationNote`) keep working through
      // the cutover. The canonical field going forward is
      // `User.verificationReason`; mobile is migrating to read it
      // directly, but until that ships the v4 endpoint would
      // produce a "Rejected — no reason" UI on every reject.
      const vendorVerificationStatus = status === "approved" ? "verified" : "rejected";
      if (user.role === "vendor") {
        // Legacy vendorVerification subdoc — populated alongside the
        // canonical field. `note` is the field the legacy mobile read.
        user.vendorVerification = {
          ...(user.vendorVerification ?? {}),
          status: vendorVerificationStatus,
          note: reason,
          reviewedAt: new Date(),
          reviewedBy: req.userId as never,
        } as never;
      }
      await user.save();

      if (user.role === "rider") {
        // Legacy RiderProfile.verificationNote — populated alongside
        // the canonical field. RiderProfile.verificationStatus uses
        // "verified" not "approved".
        const RiderProfile = (await import("../models/RiderProfile")).default;
        await RiderProfile.updateOne(
          { user: user._id },
          {
            $set: {
              verificationStatus: vendorVerificationStatus,
              verificationNote: reason,
            },
          },
        );
      }

      await writeAudit({
        actor: req.userId!,
        action: status === "approved" ? "user.verify" : "user.reject",
        targetKind: "User",
        target: String(user._id),
        after: { verificationStatus: status, verificationReason: reason },
        reason,
        ip: req.ip,
      });

      // Push to the user's socket room — mobile pending-lobby listens.
      emitToUser(String(user._id), "verification:status", {
        userId: String(user._id),
        status,
        reason,
      });

      res.json({
        message: `Verification ${status}`,
        verificationStatus: user.verificationStatus,
        verificationReason: user.verificationReason,
      });
    } catch (err) {
      console.error("[admin/users/verification]", err);
      res.status(500).json({ message: "Failed to update verification" });
    }
  }
);

// ===================== ACCOUNT STATUS (v4) =====================
/**
 * Suspend / re-activate an account. Used by trust+safety to immediately
 * kick out a violator. Mobile detects via 403 + accountStatus on the
 * next /auth/me sync (or any auth-gated call).
 */
router.patch("/users/:id/account-status", async (req, res) => {
  try {
    const { status, reason } = req.body as {
      status?: "active" | "suspended" | "pending";
      reason?: string;
    };
    if (!status || !["active", "suspended", "pending"].includes(status)) {
      return res.status(400).json({
        message: "status must be 'active', 'suspended', or 'pending'",
      });
    }
    const before = await User.findById(req.params.id)
      .select("accountStatus")
      .lean();
    if (!before) return res.status(404).json({ message: "User not found" });

    const user = await User.findByIdAndUpdate(
      req.params.id,
      { $set: { accountStatus: status } },
      { new: true }
    ).select("accountStatus role displayName phone");
    if (!user) return res.status(404).json({ message: "User not found" });

    // Best-effort push so the user gets bounced from any open session.
    if (status === "suspended") {
      emitToUser(String(user._id), "account:suspended", {
        reason,
      });
      // SEC-P1: bump tokenVersion so any in-flight access JWT for
      // the suspended user is rejected by requireAuth on the next
      // request. Pre-fix the 15-min access window meant a suspended
      // user could keep authenticating until their token expired.
      await bumpTokenVersion(String(user._id));
      // SEC-P2 (audit run 6): the socket accountStatusCache is
      // positive-only with a 60s TTL, but it's only consulted at
      // connect time. An already-connected suspended user retains
      // their socket + delivery-room membership until they reconnect.
      // Force-disconnect now so the client re-handshakes and fails
      // the isAccountAllowed gate.
      disconnectUserSockets(String(user._id));
      // P1-6 (audit run 5): pair the socket with a push so a
      // backgrounded user actually sees the suspension. Pre-fix this
      // route emitted socket-only — suspended users with the app
      // closed received nothing.
      await notifyUser(
        String(user._id),
        "account",
        "Account suspended",
        reason?.trim() ||
          "Your account has been suspended. Contact support for details.",
      ).catch(() => {});
    } else if (before.accountStatus === "suspended" && status === "active") {
      await notifyUser(
        String(user._id),
        "account",
        "Account reactivated",
        "Your account is active again. You can sign back in.",
      ).catch(() => {});
    }

    // P1: every account-status change is a privileged action.
    await writeAudit({
      actor: req.userId!,
      action: status === "active" ? "user.activate" : "user.deactivate",
      targetKind: "User",
      target: String(user._id),
      before: { accountStatus: before.accountStatus },
      after: { accountStatus: status },
      reason,
      ip: req.ip,
    });

    res.json({ message: `Account ${status}`, user });
  } catch (err) {
    console.error("[admin/users/account-status]", err);
    res.status(500).json({ message: "Failed to update account status" });
  }
});

// ===================== WITHDRAWAL HOLD (v4) =====================
/**
 * Set or clear withdrawal hold on a vendor/rider account. The wallet
 * withdraw endpoint reads this flag and 403s when active so the mobile
 * routes to /states/withdrawal-hold.
 */
router.patch("/users/:id/withdrawal-hold", async (req, res) => {
  try {
    const { active, reason } = req.body as {
      active?: boolean;
      reason?: string;
    };
    if (typeof active !== "boolean") {
      return res.status(400).json({ message: "active (boolean) is required" });
    }
    const update = active
      ? {
          "withdrawalHold.active": true,
          "withdrawalHold.reason": reason ?? "Standard payout review.",
          "withdrawalHold.setBy": req.userId,
          "withdrawalHold.setAt": new Date(),
        }
      : {
          "withdrawalHold.active": false,
          "withdrawalHold.reason": "",
        };
    const user = await User.findByIdAndUpdate(
      req.params.id,
      { $set: update },
      { new: true }
    ).select("withdrawalHold role displayName");
    if (!user) return res.status(404).json({ message: "User not found" });
    res.json({ message: `Hold ${active ? "set" : "cleared"}`, user });
  } catch {
    res.status(500).json({ message: "Failed to update withdrawal hold" });
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
