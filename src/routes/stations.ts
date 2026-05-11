import { Router } from "express";
import multer from "multer";
import GasStation from "../models/Station";
import User from "../models/User";
import cloudinary from "../utils/cloudinary";
import { requireAuth, requireAdmin } from "../middleware/auth";
import { parsePagination } from "../utils/pagination";
import { haversineDistance } from "../utils/haversine";

const router = Router();

const ALLOWED_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"];

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_MIME_TYPES.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Invalid file type. Only JPEG, PNG, and WebP are allowed."));
    }
  },
});

// ===================== GET STATIONS (DYNAMIC FILTER + SEARCH + PAGINATION) =====================
router.get("/", async (req, res) => {
  try {
    const {
      verified,
      state,
      lga,
      lat,
      lng,
      radius,
      search,
    } = req.query;

    const filter: any = {};

    if (verified !== undefined) filter.verified = verified === "true";
    if (state) filter.state = state;
    if (lga) filter.lga = lga;

    if (search) {
      // SECURITY (audit A.6): cap length + escape regex metachars
      // before injection. Unescaped user input was a ReDoS vector
      // (`(.*a){25}` worst-case) and let attackers craft regexes
      // that matched more rows than a literal-prefix search. We
      // anchor with `^…` for prefix-match semantics and case-fold
      // via `$options: i` (Mongo handles it without us touching
      // the pattern).
      const raw = String(search).slice(0, 64);
      const escaped = raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      filter.$or = [
        { name: { $regex: `^${escaped}`, $options: "i" } },
        { address: { $regex: `^${escaped}`, $options: "i" } },
      ];
    }

    if (lat && lng && radius) {
      const latNum = parseFloat(lat as string);
      const lngNum = parseFloat(lng as string);
      const r = parseFloat(radius as string);

      const latDiff = r / 111;
      const lngDiff = r / (111 * Math.cos((latNum * Math.PI) / 180));

      filter["location.lat"] = { $gte: latNum - latDiff, $lte: latNum + latDiff };
      filter["location.lng"] = { $gte: lngNum - lngDiff, $lte: lngNum + lngDiff };
    }

    const { page: pageNum, limit: limitNum, skip } = parsePagination(req.query as Record<string, unknown>);

    const [stations, total] = await Promise.all([
      GasStation.find(filter).populate("fuels.fuel").skip(skip).limit(limitNum).lean(),
      GasStation.countDocuments(filter),
    ]);

    // Enrich each station with vendor's partner status, distance, and ETA.
    const vendorIds = [...new Set(stations.map((s: any) => s.vendorId?.toString()).filter(Boolean))];
    const vendors = vendorIds.length
      ? await User.find({ _id: { $in: vendorIds } }).select("partnerBadge").lean()
      : [];
    const vendorPartnerMap = new Map(
      vendors.map((v: any) => [
        v._id.toString(),
        {
          isPartner: v.partnerBadge?.active === true,
          partnerSince: v.partnerBadge?.subscribedAt ?? null,
        },
      ])
    );

    // Distance + ETA only when the caller passed coords. The mobile
    // Stations screen relies on these so the user can sort by nearest
    // and see "X min" without computing it client-side.
    const haveCoords = lat && lng;
    const queryLat = haveCoords ? parseFloat(lat as string) : null;
    const queryLng = haveCoords ? parseFloat(lng as string) : null;

    const enriched = stations.map((s: any) => {
      let distance: number | undefined;
      let etaMinutes: number | undefined;
      if (
        queryLat != null &&
        queryLng != null &&
        s.location?.lat != null &&
        s.location?.lng != null
      ) {
        distance = haversineDistance(
          { lat: queryLat, lng: queryLng },
          { lat: s.location.lat, lng: s.location.lng }
        );
        // Rough drive-time heuristic: 3 minutes per km (Lagos traffic
        // average), floored at 5 minutes. Exposed as the canonical
        // server-side value so the client doesn't reinvent it.
        // ETA buffer: drive-time heuristic (3 min/km) + a flat 10-min
        // expectation-management buffer covering rider acceptance
        // latency, dispatcher idle time, and forecourt queueing. We
        // surface the buffered value as the canonical ETA so list
        // copy, the detail sheet, and the order receipt all agree.
        etaMinutes = Math.max(5, Math.round(distance * 3)) + 10;
      }
      const vendorMeta = s.vendorId
        ? vendorPartnerMap.get(s.vendorId.toString())
        : undefined;
      return {
        ...s,
        isPartner: vendorMeta?.isPartner === true,
        partnerSince: vendorMeta?.partnerSince ?? null,
        distance,
        etaMinutes,
      };
    });

    res.json({
      data: enriched,
      total,
      page: pageNum,
      totalPages: Math.ceil(total / limitNum),
    });
  } catch (err) {

    res.status(500).json({ message: "Failed to fetch stations" });
  }
});

// ===================== AUTO-PICK (Let Gaznger Choose) =====================
//
// Partner-weighted server-side pick. Filter to verified partners first
// (with a graceful fall-back to all stations when zero partners are in
// range), then score by:
//   price 40% — lower per-unit wins
//   ETA   35% — lower minutes wins
//   rating 25% — proxy for on-time until the server tracks on-time rate
//
// Each metric normalised to [0,1] across the candidate set; the score
// is the weighted sum and the lowest score wins. The response includes
// human-readable reasons (e.g. "Lowest price within 5 km", "Fastest ETA")
// so the mobile result sheet can show a "Why this one" list without
// duplicating the scoring logic on the client.
router.post("/auto-pick", requireAuth, async (req, res) => {
  try {
    const { lat, lng, radiusKm, fuelTypeId } = req.body ?? {};
    if (typeof lat !== "number" || typeof lng !== "number") {
      return res.status(400).json({ message: "lat + lng required" });
    }
    const r = typeof radiusKm === "number" && radiusKm > 0 ? radiusKm : 10;

    const latDiff = r / 111;
    const lngDiff = r / (111 * Math.cos((lat * Math.PI) / 180));

    const filter: any = {
      isActive: true,
      "location.lat": { $gte: lat - latDiff, $lte: lat + latDiff },
      "location.lng": { $gte: lng - lngDiff, $lte: lng + lngDiff },
    };
    if (fuelTypeId) filter["fuels.fuel"] = fuelTypeId;

    const stations = await GasStation.find(filter).populate("fuels.fuel").lean();
    if (stations.length === 0) {
      return res.status(404).json({ message: "No stations within radius" });
    }

    // Resolve vendor partner status in one batch.
    const vendorIds = [
      ...new Set(stations.map((s: any) => s.vendorId?.toString()).filter(Boolean)),
    ];
    const vendors = vendorIds.length
      ? await User.find({ _id: { $in: vendorIds } }).select("partnerBadge").lean()
      : [];
    const partnerMeta = new Map(
      vendors.map((v: any) => [
        v._id.toString(),
        {
          isPartner: v.partnerBadge?.active === true,
          partnerSince: v.partnerBadge?.subscribedAt ?? null,
        },
      ])
    );

    // Enrich each candidate with distance, ETA, perUnit (filtered to the
    // requested fuel where given), partner flag, and a flat shape for
    // scoring.
    type Candidate = {
      station: any;
      perUnit: number;
      distance: number;
      etaMinutes: number;
      rating: number;
      isPartner: boolean;
      partnerSince: Date | null;
    };
    const candidates: Candidate[] = [];
    for (const s of stations as any[]) {
      if (!s.location?.lat || !s.location?.lng) continue;
      let perUnit: number | undefined;
      if (fuelTypeId) {
        const match = s.fuels?.find(
          (f: any) =>
            (f.fuel?._id?.toString?.() ?? f.fuel?.toString?.()) ===
              String(fuelTypeId) && f.available !== false
        );
        if (!match) continue;
        perUnit = match.pricePerUnit;
      } else {
        // No fuel filter — use the cheapest available fuel as the
        // representative price so price scoring is fair across the set.
        const available = (s.fuels ?? []).filter(
          (f: any) => f.available !== false && typeof f.pricePerUnit === "number"
        );
        if (available.length === 0) continue;
        perUnit = Math.min(...available.map((f: any) => f.pricePerUnit));
      }
      if (perUnit == null) continue;
      const distance = haversineDistance(
        { lat, lng },
        { lat: s.location.lat, lng: s.location.lng }
      );
      // Same +10 expectation-management buffer as the GET / handler
      // (see comment there). Keep the two computations in sync — the
      // auto-pick result has to match the same station's row in the
      // list view, otherwise the user sees two different ETAs.
      const etaMinutes = Math.max(5, Math.round(distance * 3)) + 10;
      const meta = s.vendorId ? partnerMeta.get(s.vendorId.toString()) : undefined;
      candidates.push({
        station: s,
        perUnit,
        distance,
        etaMinutes,
        rating: s.rating ?? 0,
        isPartner: meta?.isPartner === true,
        partnerSince: meta?.partnerSince ?? null,
      });
    }

    if (candidates.length === 0) {
      return res.status(404).json({ message: "No matching stations within radius" });
    }

    // Prefer verified partners. Fall back to all candidates only when
    // no partner is in range so the user always gets an answer.
    const verifiedPartners = candidates.filter(
      (c) => c.isPartner && c.station.verified
    );
    const pool = verifiedPartners.length > 0 ? verifiedPartners : candidates;

    const minPrice = Math.min(...pool.map((c) => c.perUnit));
    const maxPrice = Math.max(...pool.map((c) => c.perUnit));
    const minEta = Math.min(...pool.map((c) => c.etaMinutes));
    const maxEta = Math.max(...pool.map((c) => c.etaMinutes));
    const maxRating = Math.max(...pool.map((c) => c.rating), 5);

    const norm = (v: number, lo: number, hi: number) =>
      hi - lo < 1e-6 ? 0 : (v - lo) / (hi - lo);

    let best: Candidate | null = null;
    let bestScore = Infinity;
    for (const c of pool) {
      const priceScore = norm(c.perUnit, minPrice, maxPrice);
      const etaScore = norm(c.etaMinutes, minEta, maxEta);
      const ratingScore = 1 - c.rating / maxRating;
      const score = 0.4 * priceScore + 0.35 * etaScore + 0.25 * ratingScore;
      if (score < bestScore) {
        bestScore = score;
        best = c;
      }
    }
    if (!best) {
      return res.status(404).json({ message: "No suitable station found" });
    }

    const reasons: string[] = [];
    if (best.perUnit === minPrice) {
      reasons.push(
        `Lowest price within ${r} km — ₦${best.perUnit.toLocaleString("en-NG")}/${
          fuelTypeId ? "unit" : "unit"
        }`
      );
    } else {
      reasons.push(
        `Competitive price — ₦${best.perUnit.toLocaleString("en-NG")} (₦${
          best.perUnit - minPrice
        } above cheapest)`
      );
    }
    if (best.etaMinutes === minEta) {
      reasons.push(`Fastest ETA — ~${best.etaMinutes} min away`);
    } else {
      reasons.push(`~${best.etaMinutes} min ETA · ${best.distance.toFixed(1)} km`);
    }
    if (best.isPartner && best.station.verified) {
      reasons.push("Verified Gaznger Partner — price honoured at delivery");
    } else if (best.isPartner) {
      reasons.push("Gaznger Partner — price honoured at delivery");
    } else if (best.station.verified) {
      reasons.push("NMDPRA-verified station");
    } else {
      reasons.push("Listed station — price guaranteed at order time");
    }

    res.json({
      station: {
        ...best.station,
        isPartner: best.isPartner,
        partnerSince: best.partnerSince,
        distance: best.distance,
        etaMinutes: best.etaMinutes,
      },
      reasons,
      score: Number(bestScore.toFixed(4)),
      pool: pool.length,
      usedPartnerFilter: verifiedPartners.length > 0,
    });
  } catch (err) {
    res.status(500).json({ message: "Failed to auto-pick station" });
  }
});

// ===================== GET STATION BY ID =====================
router.get("/:id", async (req, res) => {
  try {
    const station = await GasStation.findById(req.params.id).populate("fuels.fuel").lean();
    if (!station) return res.status(404).json({ message: "Station not found" });
    let isPartner = false;
    let partnerSince: Date | null = null;
    if ((station as any).vendorId) {
      const vendor = await User.findById((station as any).vendorId).select("partnerBadge").lean();
      isPartner = (vendor as any)?.partnerBadge?.active === true;
      partnerSince = (vendor as any)?.partnerBadge?.subscribedAt ?? null;
    }
    res.json({ ...station, isPartner, partnerSince });
  } catch (err) {

    res.status(500).json({ message: "Failed to fetch station" });
  }
});

// ===================== CREATE NEW STATION =====================
router.post("/", requireAuth, requireAdmin, upload.single("image"), async (req, res) => {
  try {
    if (!req.file)
      return res.status(400).json({ message: "Station image is required" });

    let { name, address, state, lga, location, fuels, verified } = req.body;

    if (!name || !address || !state || !lga || !location || !fuels)
      return res.status(400).json({ message: "Missing required fields" });

    let locationParsed;
    try {
      locationParsed = typeof location === "string" ? JSON.parse(location) : location;
      if (!locationParsed.lat || !locationParsed.lng) throw new Error("Invalid location");
    } catch {
      return res.status(400).json({ message: "Invalid location format. Must be JSON with lat and lng" });
    }

    const imageUpload = await new Promise<any>((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        { resource_type: "image", folder: "stations" },
        (error, result) => {
          if (error) reject(error);
          else resolve(result);
        }
      );
      stream.end(req.file!.buffer);
    });

    let fuelsParsed: any[];
    try {
      if (typeof fuels === "string") {
        fuelsParsed = JSON.parse(fuels);
        if (!Array.isArray(fuelsParsed)) fuelsParsed = [fuelsParsed];
      } else if (Array.isArray(fuels)) {
        fuelsParsed = fuels.map((f) => (typeof f === "string" ? JSON.parse(f) : f));
      } else {
        throw new Error("Invalid fuels format");
      }
      fuelsParsed.forEach((f) => {
        if (!f.fuel || typeof f.pricePerUnit !== "number") throw new Error();
      });
    } catch {
      return res.status(400).json({
        message: "Invalid fuels format. Must be JSON array of { fuel, pricePerUnit }",
      });
    }

    const station = await GasStation.create({
      name,
      address,
      state,
      lga,
      location: locationParsed,
      fuels: fuelsParsed,
      image: imageUpload.secure_url,
      verified: verified === "true" || verified === true,
    });

    res.status(201).json(station);
  } catch (err) {

    res.status(500).json({ message: "Failed to create station" });
  }
});

// ===================== UPDATE STATION =====================
router.put("/:id", requireAuth, requireAdmin, upload.single("image"), async (req, res) => {
  try {
    const station = await GasStation.findById(req.params.id);
    if (!station) return res.status(404).json({ message: "Station not found" });

    let { name, address, state, lga, location, fuels, verified } = req.body;

    if (req.file) {
      if (station.image) {
        const publicId = station.image.split("/").pop()?.split(".")[0];
        if (publicId) await cloudinary.uploader.destroy(`stations/${publicId}`);
      }
      const imageUpload = await new Promise<any>((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
          { resource_type: "image", folder: "stations" },
          (error, result) => {
            if (error) reject(error);
            else resolve(result);
          }
        );
        stream.end(req.file!.buffer);
      });
      station.image = imageUpload.secure_url;
    }

    if (name) station.name = name;
    if (address) station.address = address;
    if (state) station.state = state;
    if (lga) station.lga = lga;

    if (location) {
      try {
        const loc = typeof location === "string" ? JSON.parse(location) : location;
        if (!loc.lat || !loc.lng) throw new Error();
        station.location = loc;
      } catch {
        return res.status(400).json({ message: "Invalid location format" });
      }
    }

    if (fuels) {
      try {
        let fuelsParsed: any[];
        if (typeof fuels === "string") {
          fuelsParsed = JSON.parse(fuels);
          if (!Array.isArray(fuelsParsed)) fuelsParsed = [fuelsParsed];
        } else if (Array.isArray(fuels)) {
          fuelsParsed = fuels.map((f) => (typeof f === "string" ? JSON.parse(f) : f));
        } else throw new Error();
        fuelsParsed.forEach((f) => {
          if (!f.fuel || typeof f.pricePerUnit !== "number") throw new Error();
        });
        station.fuels = fuelsParsed;
      } catch {
        return res.status(400).json({
          message: "Invalid fuels format. Must be JSON array of { fuel, pricePerUnit }",
        });
      }
    }

    if (verified !== undefined)
      station.verified = verified === "true" || verified === true;

    await station.save();
    res.json(station);
  } catch (err) {

    res.status(500).json({ message: "Failed to update station" });
  }
});

// ===================== DELETE STATION =====================
router.delete("/:id", requireAuth, requireAdmin, async (req, res) => {
  try {
    const station = await GasStation.findById(req.params.id);
    if (!station) return res.status(404).json({ message: "Station not found" });

    if (station.image) {
      const publicId = station.image.split("/").pop()?.split(".")[0];
      if (publicId) await cloudinary.uploader.destroy(`stations/${publicId}`);
    }

    await station.deleteOne();
    res.json({ message: "Station deleted successfully" });
  } catch (err) {

    res.status(500).json({ message: "Failed to delete station" });
  }
});

export default router;
