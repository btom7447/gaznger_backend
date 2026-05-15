import { Router } from "express";
import mongoose from "mongoose";
import { requireAuth, requireVendor } from "../middleware/auth";
import User from "../models/User";
import GasStation from "../models/Station";
import Order from "../models/Order";
import RiderProfile from "../models/RiderProfile";
import RiderInvite from "../models/RiderInvite";
import Tank from "../models/Tank";
import FuelType from "../models/FuelType";

/**
 * Vendor Phase-5 endpoints — team roster, rider invites, tank levels.
 *
 * Why a separate file: vendor.ts is already ~1700 lines. Co-locating
 * by feature keeps each surface easy to reason about.
 *
 * Endpoints:
 *   GET    /api/vendor/team                     Full roster
 *   POST   /api/vendor/riders/invite            SMS-invite a rider
 *   GET    /api/vendor/riders/invites           List pending invites
 *   PATCH  /api/vendor/riders/invites/:id/revoke
 *
 *   GET    /api/vendor/tanks?stationId=         Tank levels list
 *   POST   /api/vendor/tanks                    Create tank
 *   PATCH  /api/vendor/tanks/:id                Update level / label
 *   DELETE /api/vendor/tanks/:id                Soft-delete (deactivate)
 */

const router = Router();

const ACTIVE_ORDER_STATUSES = [
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

// ===================== TEAM ROSTER =====================
/**
 * GET /api/vendor/team
 *
 * Returns every rider associated with this vendor — both via the
 * "delivered in last 30 days" inference AND any pending/accepted
 * RiderInvite rows. Sort: active → idle → offline → pending.
 *
 * Each row carries the same shape as /vendor/riders but without
 * a stationId scope (team is vendor-wide, not station-scoped) AND
 * with an extra `invite` field for pending-not-yet-signed-up rows.
 */
router.get("/team", requireAuth, requireVendor, async (req, res) => {
  try {
    const stations = await GasStation.find({ vendorId: req.userId })
      .select("_id")
      .lean();
    const allStationIds = stations.map((s) => s._id);

    // 30-day delivery-inference base.
    const THIRTY_DAYS_AGO = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const riderIds = allStationIds.length
      ? await Order.distinct("riderId", {
          station: { $in: allStationIds },
          riderId: { $exists: true },
          deliveredAt: { $gte: THIRTY_DAYS_AGO },
        })
      : [];

    const [users, profiles, activeOnOrder, tripCounts, invites] =
      await Promise.all([
        User.find({ _id: { $in: riderIds } })
          .select("displayName phone profileImage")
          .lean(),
        RiderProfile.find({ user: { $in: riderIds } })
          .select("user isAvailable vehiclePlate rating")
          .lean(),
        allStationIds.length
          ? Order.distinct("riderId", {
              station: { $in: allStationIds },
              status: { $in: ACTIVE_ORDER_STATUSES },
              riderId: { $in: riderIds },
            })
          : Promise.resolve([] as mongoose.Types.ObjectId[]),
        allStationIds.length
          ? Order.aggregate([
              {
                $match: {
                  riderId: { $in: riderIds },
                  station: { $in: allStationIds },
                  status: "delivered",
                },
              },
              { $group: { _id: "$riderId", trips: { $sum: 1 } } },
            ])
          : Promise.resolve([]),
        RiderInvite.find({
          vendor: req.userId,
          status: { $in: ["pending", "accepted"] },
        }).lean(),
      ]);

    const activeSet = new Set(activeOnOrder.map((r) => String(r)));
    const tripsById = new Map(
      tripCounts.map((t: any) => [String(t._id), t.trips as number]),
    );
    const userById = new Map(users.map((u: any) => [String(u._id), u]));
    const profileById = new Map(
      profiles.map((p: any) => [String(p.user), p]),
    );

    const acceptedInvites = invites.filter(
      (i: any) => i.status === "accepted" && i.acceptedBy,
    );
    const acceptedById = new Map(
      acceptedInvites.map((i: any) => [String(i.acceptedBy), i]),
    );

    // Build rows: delivered-set first, then accepted-invite rows for
    // riders who haven't delivered yet, then pending invites.
    const seenUserIds = new Set<string>();
    const rows: any[] = [];
    for (const rid of riderIds) {
      const id = String(rid);
      seenUserIds.add(id);
      const u = userById.get(id);
      const p = profileById.get(id);
      const isActive = activeSet.has(id);
      const status: "active" | "idle" | "offline" = isActive
        ? "active"
        : p?.isAvailable
          ? "idle"
          : "offline";
      rows.push({
        kind: "rider",
        id,
        name: u?.displayName ?? "Rider",
        phone: u?.phone ?? null,
        plate: p?.vehiclePlate ?? null,
        rating: typeof p?.rating === "number" ? p.rating : null,
        trips: tripsById.get(id) ?? 0,
        status,
        inviteId: acceptedById.get(id)?._id?.toString() ?? null,
      });
    }
    // Accepted invites where the rider hasn't delivered yet.
    for (const inv of acceptedInvites) {
      const id = String(inv.acceptedBy);
      if (seenUserIds.has(id)) continue;
      seenUserIds.add(id);
      const u = userById.get(id);
      if (!u) {
        // User may not be in our prefetched batch — fetch lazily.
        try {
          const fresh = await User.findById(id)
            .select("displayName phone profileImage")
            .lean();
          if (fresh) {
            rows.push({
              kind: "rider",
              id,
              name: (fresh as any).displayName ?? "Rider",
              phone: (fresh as any).phone ?? null,
              plate: null,
              rating: null,
              trips: 0,
              status: "offline",
              inviteId: inv._id.toString(),
            });
          }
        } catch {
          // ignore
        }
      } else {
        rows.push({
          kind: "rider",
          id,
          name: (u as any).displayName ?? "Rider",
          phone: (u as any).phone ?? null,
          plate: null,
          rating: null,
          trips: 0,
          status: "offline",
          inviteId: inv._id.toString(),
        });
      }
    }
    // Pending invites — not yet signed up.
    for (const inv of invites) {
      if (inv.status !== "pending") continue;
      rows.push({
        kind: "invite",
        id: inv._id.toString(),
        name: inv.displayName ?? "Pending rider",
        phone: inv.phone,
        plate: null,
        rating: null,
        trips: 0,
        status: "pending",
        inviteId: inv._id.toString(),
        invitedAt: inv.createdAt,
      });
    }

    rows.sort((a, b) => {
      const rank = (r: typeof a) =>
        r.status === "active"
          ? 0
          : r.status === "idle"
            ? 1
            : r.status === "offline"
              ? 2
              : 3;
      return rank(a) - rank(b);
    });

    res.json({ team: rows });
  } catch (err) {
    console.error("[vendor/team]", err);
    res.status(500).json({ message: "Failed to fetch team" });
  }
});

// ===================== INVITE RIDER =====================
/**
 * POST /api/vendor/riders/invite { phone, displayName? }
 *
 * Mints a RiderInvite row + sends an SMS with a deep-link token.
 * Re-issuing for an already-pending phone refreshes the TTL but
 * keeps the existing token.
 */
router.post("/riders/invite", requireAuth, requireVendor, async (req, res) => {
  try {
    const { phone, displayName } = req.body as {
      phone?: string;
      displayName?: string;
    };
    if (!phone || !/^\+?\d{10,15}$/.test(phone.replace(/\s+/g, ""))) {
      return res.status(400).json({ message: "Valid phone required" });
    }
    const normPhone = phone.startsWith("+") ? phone : `+${phone}`;

    // Look up: do we already have a pending invite for this phone?
    let invite = await RiderInvite.findOne({
      vendor: req.userId,
      phone: normPhone,
      status: { $in: ["pending", "accepted"] },
    });
    if (invite && invite.status === "pending") {
      // Bump TTL.
      invite.expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      if (displayName?.trim()) invite.displayName = displayName.trim();
      await invite.save();
    } else if (!invite) {
      invite = await RiderInvite.create({
        vendor: req.userId,
        phone: normPhone,
        displayName: displayName?.trim() || undefined,
      });
    }

    // SMS dispatch — generic transactional SMS isn't wired yet (sms.ts
    // is OTP-template-shaped). For now we return the invite URL in the
    // response so the vendor's mobile app can share it via the OS
    // share sheet (WhatsApp / SMS / etc.). Server-driven SMS lands in
    // v6.5 with the broader notifications overhaul.
    const inviteUrl = `${process.env.EXPO_PUBLIC_BASE_URL || "https://api.gaznger.com"}/invite/${invite.token}`;
    res.status(201).json({ invite, inviteUrl });
  } catch (err) {
    console.error("[vendor/riders/invite]", err);
    res.status(500).json({ message: "Failed to invite rider" });
  }
});

// ===================== LIST PENDING INVITES =====================
router.get("/riders/invites", requireAuth, requireVendor, async (_req, res) => {
  try {
    const invites = await RiderInvite.find({
      vendor: _req.userId,
      status: { $in: ["pending", "accepted"] },
    })
      .sort({ createdAt: -1 })
      .lean();
    res.json({ invites });
  } catch (err) {
    res.status(500).json({ message: "Failed to fetch invites" });
  }
});

// ===================== REVOKE INVITE =====================
router.patch(
  "/riders/invites/:id/revoke",
  requireAuth,
  requireVendor,
  async (req, res) => {
    try {
      const idStr = Array.isArray(req.params.id)
        ? req.params.id[0]
        : (req.params.id as string);
      const invite = await RiderInvite.findOneAndUpdate(
        { _id: idStr, vendor: req.userId, status: "pending" },
        { $set: { status: "revoked" } },
        { new: true },
      );
      if (!invite) {
        return res.status(404).json({ message: "Invite not found" });
      }
      res.json({ invite });
    } catch (err) {
      res.status(500).json({ message: "Failed to revoke invite" });
    }
  },
);

// ===================== TANK LIST =====================
/**
 * GET /api/vendor/tanks?stationId=
 *
 * Tanks at the vendor's station. If stationId omitted, returns all
 * tanks across all vendor's stations.
 */
router.get("/tanks", requireAuth, requireVendor, async (req, res) => {
  try {
    const stations = await GasStation.find({ vendorId: req.userId })
      .select("_id")
      .lean();
    const allStationIds = stations.map((s) => s._id);
    if (!allStationIds.length) {
      return res.status(200).json({ tanks: [] });
    }
    const { stationId } = req.query as { stationId?: string };
    const scoped =
      stationId && allStationIds.some((id) => id.toString() === stationId)
        ? [new mongoose.Types.ObjectId(stationId)]
        : allStationIds;

    const tanks = await Tank.find({
      station: { $in: scoped },
      isActive: true,
    })
      .populate("fuelType", "name unit")
      .populate("station", "name")
      .lean();

    res.json({ tanks });
  } catch (err) {
    console.error("[vendor/tanks]", err);
    res.status(500).json({ message: "Failed to fetch tanks" });
  }
});

// ===================== CREATE TANK =====================
router.post("/tanks", requireAuth, requireVendor, async (req, res) => {
  try {
    const { stationId, fuelTypeId, capacity, currentLevel, label, lowThresholdPct } =
      req.body as {
        stationId?: string;
        fuelTypeId?: string;
        capacity?: number;
        currentLevel?: number;
        label?: string;
        lowThresholdPct?: number;
      };
    if (!stationId || !fuelTypeId || !capacity || capacity <= 0) {
      return res.status(400).json({
        message: "stationId, fuelTypeId, capacity required",
      });
    }
    const station = await GasStation.findOne({
      _id: stationId,
      vendorId: req.userId,
    });
    if (!station) return res.status(404).json({ message: "Station not found" });
    const fuel = await FuelType.findById(fuelTypeId);
    if (!fuel) return res.status(404).json({ message: "Fuel not found" });

    const tank = await Tank.create({
      station: stationId,
      vendor: req.userId,
      fuelType: fuelTypeId,
      unit: fuel.unit,
      capacity,
      currentLevel: typeof currentLevel === "number" ? currentLevel : 0,
      label: label?.trim() || undefined,
      lowThresholdPct:
        typeof lowThresholdPct === "number" ? lowThresholdPct : 25,
    });
    res.status(201).json({ tank });
  } catch (err) {
    console.error("[vendor/tanks POST]", err);
    res.status(500).json({ message: "Failed to create tank" });
  }
});

// ===================== UPDATE TANK =====================
router.patch("/tanks/:id", requireAuth, requireVendor, async (req, res) => {
  try {
    const idStr = Array.isArray(req.params.id)
      ? req.params.id[0]
      : (req.params.id as string);
    const { currentLevel, capacity, label, lowThresholdPct, isActive } =
      req.body as {
        currentLevel?: number;
        capacity?: number;
        label?: string;
        lowThresholdPct?: number;
        isActive?: boolean;
      };

    const update: Record<string, unknown> = {};
    if (typeof currentLevel === "number") {
      update.currentLevel = Math.max(0, currentLevel);
      update.lastUpdatedAt = new Date();
    }
    if (typeof capacity === "number" && capacity > 0) update.capacity = capacity;
    if (typeof label === "string") update.label = label.trim() || undefined;
    if (typeof lowThresholdPct === "number") {
      update.lowThresholdPct = Math.max(0, Math.min(100, lowThresholdPct));
    }
    if (typeof isActive === "boolean") update.isActive = isActive;

    if (Object.keys(update).length === 0) {
      return res.status(400).json({ message: "Nothing to update" });
    }

    const tank = await Tank.findOneAndUpdate(
      { _id: idStr, vendor: req.userId },
      { $set: update },
      { new: true },
    );
    if (!tank) return res.status(404).json({ message: "Tank not found" });
    res.json({ tank });
  } catch (err) {
    console.error("[vendor/tanks PATCH]", err);
    res.status(500).json({ message: "Failed to update tank" });
  }
});

// ===================== DELETE (deactivate) TANK =====================
router.delete("/tanks/:id", requireAuth, requireVendor, async (req, res) => {
  try {
    const idStr = Array.isArray(req.params.id)
      ? req.params.id[0]
      : (req.params.id as string);
    const tank = await Tank.findOneAndUpdate(
      { _id: idStr, vendor: req.userId },
      { $set: { isActive: false } },
      { new: true },
    );
    if (!tank) return res.status(404).json({ message: "Tank not found" });
    res.json({ tank });
  } catch (err) {
    res.status(500).json({ message: "Failed to delete tank" });
  }
});

export default router;
