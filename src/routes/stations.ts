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
      filter.$or = [
        { name: { $regex: search, $options: "i" } },
        { address: { $regex: search, $options: "i" } },
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
      vendors.map((v: any) => [v._id.toString(), v.partnerBadge?.active === true])
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
        etaMinutes = Math.max(5, Math.round(distance * 3));
      }
      return {
        ...s,
        isPartner: s.vendorId ? (vendorPartnerMap.get(s.vendorId.toString()) ?? false) : false,
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

// ===================== GET STATION BY ID =====================
router.get("/:id", async (req, res) => {
  try {
    const station = await GasStation.findById(req.params.id).populate("fuels.fuel").lean();
    if (!station) return res.status(404).json({ message: "Station not found" });
    let isPartner = false;
    if ((station as any).vendorId) {
      const vendor = await User.findById((station as any).vendorId).select("partnerBadge").lean();
      isPartner = (vendor as any)?.partnerBadge?.active === true;
    }
    res.json({ ...station, isPartner });
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
