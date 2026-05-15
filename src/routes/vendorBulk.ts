import { Router } from "express";
import mongoose from "mongoose";
import { requireAuth, requireVendor } from "../middleware/auth";
import GasStation from "../models/Station";
import FuelType from "../models/FuelType";
import FuelPlant from "../models/FuelPlant";
import FuelPlantOrder, {
  type FuelPlantOrderStep,
  STEP_ORDER,
} from "../models/FuelPlantOrder";
import BulkDispute from "../models/BulkDispute";
import { emitToUser } from "../socket";
import { notifyUser } from "../utils/notify";
import { getCommissionRate } from "../utils/platformConfig";

/**
 * Vendor bulk-purchase routes — backs the v6 Supplies screens:
 *   - GET /api/vendor/plants                       List approved depots
 *   - GET /api/vendor/bulk-purchases               List vendor's bulk POs
 *   - GET /api/vendor/bulk-purchases/:id           PO detail (tracker)
 *   - POST /api/vendor/bulk-purchases              Create (wizard submit)
 *   - PATCH /api/vendor/bulk-purchases/:id/paid    Mark escrow paid
 *   - PATCH /api/vendor/bulk-purchases/:id/receive Confirm truck arrival
 *   - PATCH /api/vendor/bulk-purchases/:id/offload Submit offloaded qty
 *   - PATCH /api/vendor/bulk-purchases/:id/reconcile         Close (ok)
 *   - PATCH /api/vendor/bulk-purchases/:id/accept-variance   Close w/ var
 *   - PATCH /api/vendor/bulk-purchases/:id/dispute           Open dispute
 *   - POST /api/vendor/bulk-purchases/:id/dispute/message    Append msg
 *
 * Pipeline is 11 steps (FuelPlantOrder.step). Steps 1, 3, 10, 11 are
 * vendor-driven; 2 & 4-9 are plant/driver-driven (admin tooling will
 * fire those in v6.5). On the design-handoff timeline, vendor sees
 * timestamps for every step regardless of who advanced it.
 */

const router = Router();

const VARIANCE_TOLERANCE_PCT = 0.5;

/** Variance % rounded to 2 dp. Positive = vendor received less than loaded. */
function computeVariancePct(loaded: number, offloaded: number): number {
  if (!loaded || loaded <= 0) return 0;
  return Number((((loaded - offloaded) / loaded) * 100).toFixed(2));
}

/** Append a timeline entry + bump the step pointer + map to legacy status. */
function advanceStep(
  doc: any,
  step: FuelPlantOrderStep,
  by: "plant" | "vendor" | "driver" | "system",
  note?: string,
) {
  doc.timeline = doc.timeline ?? [];
  doc.timeline.push({ step, at: new Date(), by, note });
  doc.step = step;

  // Map granular step → legacy 5-status enum so any old admin tooling
  // querying by status still groups correctly.
  if (step === "requested" || step === "acknowledged") {
    doc.status = "pending";
  } else if (step === "paid" || step === "allocated" || step === "truck_scheduled" || step === "driver_verified" || step === "loading") {
    doc.status = "confirmed";
  } else if (step === "dispatched" || step === "in_transit" || step === "at_station") {
    doc.status = "in-transit";
  } else if (step === "offloaded") {
    // Stays "in-transit" until reconcile closes it.
    doc.status = "in-transit";
  }
}

// ===================== LIST APPROVED DEPOTS =====================
/**
 * GET /api/vendor/plants
 *
 * Approved depots vendors can buy bulk from. Filter via ?fuelTypeId,
 * ?state, ?sort=reliability|distance|price. `distance` requires the
 * caller to pass &lat=&lng=.
 */
router.get("/plants", requireAuth, requireVendor, async (req, res) => {
  try {
    const { fuelTypeId, state, sort } = req.query as Record<string, string>;
    const filter: Record<string, unknown> = { isApproved: true, isActive: true };
    if (state) filter.state = state;
    if (fuelTypeId) {
      filter["products.fuel"] = new mongoose.Types.ObjectId(fuelTypeId);
      filter["products.available"] = true;
    }

    const plants = (await FuelPlant.find(filter)
      .populate("products.fuel", "name unit")
      .lean()) as any[];

    // Apply sort. For "price" we sort by the cheapest available product
    // matching fuelTypeId (or any product if fuelTypeId omitted).
    if (sort === "reliability") {
      plants.sort(
        (a, b) =>
          (b.reliabilityScore ?? 0) - (a.reliabilityScore ?? 0),
      );
    } else if (sort === "price") {
      const fid = fuelTypeId ?? null;
      const cheapest = (p: any) => {
        const items = (p.products ?? []).filter(
          (x: any) =>
            x.available &&
            (!fid || String(x.fuel?._id ?? x.fuel) === fid),
        );
        if (!items.length) return Infinity;
        return Math.min(...items.map((x: any) => x.pricePerUnit));
      };
      plants.sort((a, b) => cheapest(a) - cheapest(b));
    } else if (sort === "distance") {
      const lat = Number(req.query.lat);
      const lng = Number(req.query.lng);
      if (Number.isFinite(lat) && Number.isFinite(lng)) {
        const hav = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) => {
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
        const here = { lat, lng };
        plants.forEach((p: any) => {
          p._distanceKm = p.location ? hav(here, p.location) : Infinity;
        });
        plants.sort((a: any, b: any) => a._distanceKm - b._distanceKm);
      }
    }

    res.json({ plants });
  } catch (err) {
    console.error("[vendor/plants]", err);
    res.status(500).json({ message: "Failed to fetch plants" });
  }
});

// ===================== LIST BULK PURCHASES =====================
/**
 * GET /api/vendor/bulk-purchases
 *
 * Filters: ?stationId, ?status (one of legacy enum), ?filter=in-flight|
 * history.
 *   - in-flight = step is anything other than offloaded + status !=
 *     delivered/cancelled
 *   - history   = status in (delivered, cancelled) OR step = offloaded
 *     w/ reconcileOutcome set.
 *
 * Returns paginated preview rows ready for the Supplies in-flight card.
 */
router.get("/bulk-purchases", requireAuth, requireVendor, async (req, res) => {
  try {
    const stations = await GasStation.find({ vendorId: req.userId })
      .select("_id")
      .lean();
    if (!stations.length) {
      return res.status(200).json({ orders: [], total: 0, page: 1, pages: 0 });
    }
    const allStationIds = stations.map((s) => s._id);

    const {
      stationId,
      status,
      filter,
      page = "1",
      limit = "20",
    } = req.query as Record<string, string>;

    const scopedStationIds =
      stationId && allStationIds.some((id) => id.toString() === stationId)
        ? [new mongoose.Types.ObjectId(stationId)]
        : allStationIds;

    const q: Record<string, unknown> = {
      vendor: req.userId,
      station: { $in: scopedStationIds },
    };
    if (status) q.status = status;
    if (filter === "in-flight") {
      q.status = { $in: ["pending", "confirmed", "in-transit"] };
    } else if (filter === "history") {
      q.status = { $in: ["delivered", "cancelled"] };
    }

    const pageNum = Math.max(1, parseInt(page, 10));
    const limitNum = Math.min(50, Math.max(1, parseInt(limit, 10)));
    const skip = (pageNum - 1) * limitNum;

    const [docs, total] = await Promise.all([
      FuelPlantOrder.find(q)
        .populate("plant", "name shortName image")
        .populate("fuelType", "name unit")
        .populate("station", "name")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .lean(),
      FuelPlantOrder.countDocuments(q),
    ]);

    const orders = docs.map((o: any) => {
      const stepIndex = o.step ? STEP_ORDER.indexOf(o.step) : -1;
      return {
        id: String(o._id),
        plantName: o.plant?.shortName ?? o.plant?.name ?? o.supplierName ?? "—",
        plantImage: o.plant?.image ?? null,
        product: o.fuelType?.name ?? "Fuel",
        qty: `${o.quantity ?? 0} ${o.fuelType?.unit ?? o.unit ?? ""}`.trim(),
        totalCost: o.totalCost,
        totalCostFormatted: `₦${Number(o.totalCost ?? 0).toLocaleString("en-NG")}`,
        status: o.status,
        step: o.step,
        stepIndex,
        stepLabel: stepIndex >= 0 ? `${stepIndex + 1} / 11` : null,
        progressPct: stepIndex >= 0 ? Math.round(((stepIndex + 1) / 11) * 100) : 0,
        truckPlate: o.truckPlate ?? null,
        estimatedDelivery: o.estimatedDelivery ?? null,
        stationName: o.station?.name ?? null,
        createdAt: o.createdAt,
      };
    });

    res.json({
      orders,
      total,
      page: pageNum,
      pages: Math.ceil(total / limitNum),
    });
  } catch (err) {
    console.error("[vendor/bulk-purchases list]", err);
    res.status(500).json({ message: "Failed to fetch bulk purchases" });
  }
});

// ===================== GET BULK PURCHASE BY ID =====================
router.get("/bulk-purchases/:id", requireAuth, requireVendor, async (req, res) => {
  try {
    const stations = await GasStation.find({ vendorId: req.userId })
      .select("_id")
      .lean();
    const stationIds = stations.map((s) => s._id);

    const doc = (await FuelPlantOrder.findOne({
      _id: req.params.id,
      vendor: req.userId,
      station: { $in: stationIds },
    })
      .populate("plant")
      .populate("fuelType", "name unit")
      .populate("station", "name address location")
      .lean()) as any;

    if (!doc) return res.status(404).json({ message: "Purchase not found" });

    const dispute = await BulkDispute.findOne({ bulkOrder: doc._id }).lean();

    res.json({
      ...doc,
      stepOrder: STEP_ORDER,
      varianceTolerancePct: VARIANCE_TOLERANCE_PCT,
      dispute: dispute ?? null,
    });
  } catch (err) {
    console.error("[vendor/bulk-purchases/:id]", err);
    res.status(500).json({ message: "Failed to fetch purchase" });
  }
});

// ===================== CREATE BULK PURCHASE =====================
/**
 * POST /api/vendor/bulk-purchases
 *
 * Body: {
 *   stationId, plantId, fuelTypeId, quantity, deliveryWindow?, notes?
 * }
 *
 * Server computes price (plant.products[fuel].pricePerUnit × qty) +
 * service fee (PlatformConfig "vendor" rate, same machinery as audit
 * C.4) + a fixed logistics fee placeholder (TODO: plant-supplied).
 *
 * Initial step = "requested". Customer (vendor) sees the row in
 * Supplies immediately; plant ack flips it to "acknowledged" in v6.5.
 */
router.post("/bulk-purchases", requireAuth, requireVendor, async (req, res) => {
  try {
    const {
      stationId,
      plantId,
      fuelTypeId,
      quantity,
      deliveryWindow,
      notes,
    } = req.body as {
      stationId?: string;
      plantId?: string;
      fuelTypeId?: string;
      quantity?: number;
      deliveryWindow?: string;
      notes?: string;
    };

    if (!stationId || !plantId || !fuelTypeId || !quantity || quantity <= 0) {
      return res.status(400).json({
        message: "stationId, plantId, fuelTypeId, quantity required",
      });
    }

    const [station, plant, fuelType] = await Promise.all([
      GasStation.findOne({ _id: stationId, vendorId: req.userId }).lean(),
      FuelPlant.findOne({ _id: plantId, isApproved: true, isActive: true }).lean(),
      FuelType.findById(fuelTypeId).lean(),
    ]);
    if (!station) return res.status(404).json({ message: "Station not found" });
    if (!plant) return res.status(404).json({ message: "Plant not found" });
    if (!fuelType) return res.status(404).json({ message: "Fuel not found" });

    const product = (plant.products ?? []).find(
      (p: any) => String(p.fuel) === String(fuelTypeId) && p.available,
    );
    if (!product) {
      return res.status(400).json({
        message: "Selected fuel is not available at this plant",
      });
    }

    const pricePerUnit = product.pricePerUnit;
    const subtotal = Math.round(quantity * pricePerUnit);

    // Logistics fee — placeholder; plant-quoted in v6.5.
    const logisticsFee = 0;

    // Gaznger fee — mirror serviceFee pattern from orders. Pull live
    // rate from PlatformConfig (admin-editable); default 2% if unset.
    let serviceFeeBps = 200;
    try {
      const rate = await getCommissionRate("vendor");
      // Convert decimal (0.02) → bps (200); fall back to 200 if NaN.
      const bps = Math.round(Number(rate) * 10_000);
      if (Number.isFinite(bps) && bps >= 0) serviceFeeBps = bps;
    } catch {
      // Fall back to default 200 bps.
    }
    const serviceFee = Math.round((subtotal * serviceFeeBps) / 10_000);
    const totalCost = subtotal + logisticsFee + serviceFee;

    const now = new Date();
    const doc = await FuelPlantOrder.create({
      vendor: req.userId,
      station: stationId,
      plant: plantId,
      fuelType: fuelTypeId,
      quantity,
      unit: fuelType.unit,
      pricePerUnit,
      logisticsFee,
      serviceFee,
      totalCost,
      status: "pending",
      step: "requested",
      timeline: [
        {
          step: "requested",
          at: now,
          by: "vendor",
          note: notes?.trim() || undefined,
        },
      ],
      deliveryWindow: deliveryWindow?.trim() || undefined,
      notes: notes?.trim() || undefined,
      supplierName: plant.name,
    });

    res.status(201).json({ order: doc });
  } catch (err) {
    console.error("[vendor/bulk-purchases POST]", err);
    res.status(500).json({ message: "Failed to create purchase" });
  }
});

// ===================== INTERNAL: fetch owned PO =====================
async function loadOwnedPO(vendorId: string, id: unknown) {
  // Express 5 types req.params as Record<string, string | string[]>; we
  // accept the wider input and normalise to a single string here.
  const idStr = Array.isArray(id) ? id[0] : (id as string | undefined);
  if (!idStr) return null;
  const stations = await GasStation.find({ vendorId }).select("_id").lean();
  const stationIds = stations.map((s) => s._id);
  return FuelPlantOrder.findOne({
    _id: idStr,
    vendor: vendorId,
    station: { $in: stationIds },
  });
}

// ===================== MARK ESCROW PAID =====================
router.patch("/bulk-purchases/:id/paid", requireAuth, requireVendor, async (req, res) => {
  try {
    const doc = await loadOwnedPO(req.userId!, req.params.id);
    if (!doc) return res.status(404).json({ message: "Purchase not found" });
    if (doc.paymentStatus === "paid") {
      return res.status(409).json({ message: "Already paid" });
    }
    doc.paymentStatus = "paid";
    doc.paymentRef = (req.body?.paymentRef as string) ?? doc.paymentRef;
    advanceStep(doc, "paid", "vendor");
    await doc.save();
    emitToUser(req.userId!, "bulk:update", { id: String(doc._id), step: doc.step });
    res.json({ order: doc });
  } catch (err) {
    console.error("[vendor/bulk/paid]", err);
    res.status(500).json({ message: "Failed to mark paid" });
  }
});

// ===================== CONFIRM TRUCK ARRIVAL =====================
router.patch("/bulk-purchases/:id/receive", requireAuth, requireVendor, async (req, res) => {
  try {
    const doc = await loadOwnedPO(req.userId!, req.params.id);
    if (!doc) return res.status(404).json({ message: "Purchase not found" });
    advanceStep(doc, "at_station", "vendor");
    await doc.save();
    emitToUser(req.userId!, "bulk:update", { id: String(doc._id), step: doc.step });
    res.json({ order: doc });
  } catch (err) {
    console.error("[vendor/bulk/receive]", err);
    res.status(500).json({ message: "Failed to confirm receipt" });
  }
});

// ===================== SUBMIT OFFLOADED QUANTITY =====================
router.patch("/bulk-purchases/:id/offload", requireAuth, requireVendor, async (req, res) => {
  try {
    const { offloadedQty, loadedQty } = req.body as {
      offloadedQty?: number;
      loadedQty?: number;
    };
    if (!offloadedQty || offloadedQty <= 0) {
      return res.status(400).json({ message: "offloadedQty required" });
    }
    const doc = await loadOwnedPO(req.userId!, req.params.id);
    if (!doc) return res.status(404).json({ message: "Purchase not found" });
    if (typeof loadedQty === "number" && loadedQty > 0) {
      doc.loadedQty = loadedQty;
    } else if (!doc.loadedQty) {
      // Plant didn't set it before dispatch — assume requested quantity
      // is the loaded baseline.
      doc.loadedQty = doc.quantity;
    }
    doc.offloadedQty = offloadedQty;
    doc.variancePct = computeVariancePct(doc.loadedQty!, offloadedQty);
    advanceStep(doc, "offloaded", "vendor");
    await doc.save();
    emitToUser(req.userId!, "bulk:update", {
      id: String(doc._id),
      step: doc.step,
      variancePct: doc.variancePct,
    });
    res.json({ order: doc });
  } catch (err) {
    console.error("[vendor/bulk/offload]", err);
    res.status(500).json({ message: "Failed to record offload" });
  }
});

// ===================== RECONCILE (close out, no variance) =====================
router.patch("/bulk-purchases/:id/reconcile", requireAuth, requireVendor, async (req, res) => {
  try {
    const doc = await loadOwnedPO(req.userId!, req.params.id);
    if (!doc) return res.status(404).json({ message: "Purchase not found" });
    if (doc.step !== "offloaded") {
      return res.status(409).json({ message: "Submit offload first" });
    }
    const variance = doc.variancePct ?? 0;
    if (Math.abs(variance) > VARIANCE_TOLERANCE_PCT) {
      return res.status(409).json({
        message: `Variance ${variance}% exceeds ${VARIANCE_TOLERANCE_PCT}% tolerance. Open a dispute or accept the variance.`,
      });
    }
    doc.reconcileOutcome = "ok";
    doc.closedAt = new Date();
    doc.status = "delivered";
    doc.timeline = doc.timeline ?? [];
    doc.timeline.push({
      step: "offloaded",
      at: new Date(),
      by: "vendor",
      note: "Reconciled within tolerance — closed.",
    });
    await doc.save();
    emitToUser(req.userId!, "bulk:update", {
      id: String(doc._id),
      step: doc.step,
      status: doc.status,
    });
    res.json({ order: doc });
  } catch (err) {
    console.error("[vendor/bulk/reconcile]", err);
    res.status(500).json({ message: "Failed to reconcile" });
  }
});

// ===================== ACCEPT VARIANCE (close out w/ variance) =====================
router.patch("/bulk-purchases/:id/accept-variance", requireAuth, requireVendor, async (req, res) => {
  try {
    const doc = await loadOwnedPO(req.userId!, req.params.id);
    if (!doc) return res.status(404).json({ message: "Purchase not found" });
    if (doc.step !== "offloaded") {
      return res.status(409).json({ message: "Submit offload first" });
    }
    doc.reconcileOutcome = "accept_variance";
    doc.closedAt = new Date();
    doc.status = "delivered";
    doc.timeline = doc.timeline ?? [];
    doc.timeline.push({
      step: "offloaded",
      at: new Date(),
      by: "vendor",
      note: `Variance ${doc.variancePct ?? 0}% accepted by vendor — closed.`,
    });
    await doc.save();
    emitToUser(req.userId!, "bulk:update", {
      id: String(doc._id),
      step: doc.step,
      status: doc.status,
    });
    res.json({ order: doc });
  } catch (err) {
    console.error("[vendor/bulk/accept-variance]", err);
    res.status(500).json({ message: "Failed to accept variance" });
  }
});

// ===================== OPEN DISPUTE =====================
router.patch("/bulk-purchases/:id/dispute", requireAuth, requireVendor, async (req, res) => {
  try {
    const { reason } = req.body as { reason?: string };
    const doc = await loadOwnedPO(req.userId!, req.params.id);
    if (!doc) return res.status(404).json({ message: "Purchase not found" });
    if (doc.step !== "offloaded") {
      return res.status(409).json({ message: "Submit offload first" });
    }

    doc.reconcileOutcome = "dispute";
    doc.timeline = doc.timeline ?? [];
    doc.timeline.push({
      step: "offloaded",
      at: new Date(),
      by: "vendor",
      note: "Variance dispute opened.",
    });
    await doc.save();

    const existing = await BulkDispute.findOne({ bulkOrder: doc._id });
    let dispute = existing;
    if (!dispute) {
      dispute = await BulkDispute.create({
        bulkOrder: doc._id,
        vendor: doc.vendor,
        plant: doc.plant,
        snapshot: {
          loadedQty: doc.loadedQty ?? doc.quantity,
          offloadedQty: doc.offloadedQty ?? 0,
          variancePct: doc.variancePct ?? 0,
        },
        messages: reason?.trim()
          ? [
              {
                role: "vendor",
                by: new mongoose.Types.ObjectId(req.userId!),
                body: reason.trim(),
                at: new Date(),
              },
            ]
          : [],
      });
    }

    emitToUser(req.userId!, "bulk:update", {
      id: String(doc._id),
      step: doc.step,
      reconcileOutcome: doc.reconcileOutcome,
    });

    res.json({ order: doc, dispute });
  } catch (err) {
    console.error("[vendor/bulk/dispute]", err);
    res.status(500).json({ message: "Failed to open dispute" });
  }
});

// ===================== APPEND DISPUTE MESSAGE =====================
router.post(
  "/bulk-purchases/:id/dispute/message",
  requireAuth,
  requireVendor,
  async (req, res) => {
    try {
      const { body, attachments } = req.body as {
        body?: string;
        attachments?: string[];
      };
      if (!body || !body.trim()) {
        return res.status(400).json({ message: "Message body required" });
      }
      const doc = await loadOwnedPO(req.userId!, req.params.id);
      if (!doc) return res.status(404).json({ message: "Purchase not found" });

      const dispute = await BulkDispute.findOne({ bulkOrder: doc._id });
      if (!dispute) {
        return res.status(404).json({ message: "Dispute not found" });
      }
      dispute.messages.push({
        role: "vendor",
        by: new mongoose.Types.ObjectId(req.userId!),
        body: body.trim(),
        attachments: Array.isArray(attachments) ? attachments : undefined,
        at: new Date(),
      });
      await dispute.save();
      res.json({ dispute });
    } catch (err) {
      console.error("[vendor/bulk/dispute/message]", err);
      res.status(500).json({ message: "Failed to send message" });
    }
  },
);

export default router;
