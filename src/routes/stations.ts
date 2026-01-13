import { Router } from "express";
import multer from "multer";
import GasStation from "../models/Station";
import cloudinary from "../utils/cloudinary";

const router = Router();
const upload = multer({ storage: multer.memoryStorage() });

/**
 * @swagger
 * tags:
 *   name: Stations
 *   description: Gas station management
 */

// ===================== GET STATIONS (DYNAMIC FILTER) =====================
/**
 * @swagger
 * /api/stations:
 *   get:
 *     summary: Fetch stations (all, by state/LGA, or by radius)
 *     tags: [Stations]
 *     parameters:
 *       - in: query
 *         name: verified
 *         schema:
 *           type: boolean
 *       - in: query
 *         name: state
 *         schema:
 *           type: string
 *         description: Filter by state
 *       - in: query
 *         name: lga
 *         schema:
 *           type: string
 *         description: Filter by LGA
 *       - in: query
 *         name: lat
 *         schema:
 *           type: number
 *         description: Latitude for radius search
 *       - in: query
 *         name: lng
 *         schema:
 *           type: number
 *         description: Longitude for radius search
 *       - in: query
 *         name: radius
 *         schema:
 *           type: number
 *         description: Radius in KM for location search
 *     responses:
 *       200:
 *         description: List of stations
 *       500:
 *         description: Server error
 */
router.get("/", async (req, res) => {
  try {
    const { verified, state, lga, lat, lng, radius } = req.query;
    const filter: any = {};

    if (verified !== undefined) filter.verified = verified === "true";
    if (state) filter.state = state;
    if (lga) filter.lga = lga;

    if (lat && lng && radius) {
      const latNum = parseFloat(lat as string);
      const lngNum = parseFloat(lng as string);
      const r = parseFloat(radius as string);

      const latDiff = r / 111;
      const lngDiff = r / (111 * Math.cos((latNum * Math.PI) / 180));

      filter["location.lat"] = {
        $gte: latNum - latDiff,
        $lte: latNum + latDiff,
      };
      filter["location.lng"] = {
        $gte: lngNum - lngDiff,
        $lte: lngNum + lngDiff,
      };
    }

    const stations = await GasStation.find(filter).populate("fuels.fuel");
    res.json(stations);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to fetch stations" });
  }
});

// ===================== GET STATION BY ID =====================
/**
 * @swagger
 * /api/stations/{id}:
 *   get:
 *     summary: Get a station by ID
 *     tags: [Stations]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Station ID
 *     responses:
 *       200:
 *         description: Station details
 *       404:
 *         description: Station not found
 *       500:
 *         description: Server error
 */
router.get("/:id", async (req, res) => {
  try {
    const station = await GasStation.findById(req.params.id).populate(
      "fuels.fuel"
    );
    if (!station) return res.status(404).json({ message: "Station not found" });
    res.json(station);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to fetch station" });
  }
});

// ===================== CREATE NEW STATION =====================
/**
 * @swagger
 * /api/stations:
 *   post:
 *     summary: Create a new gas station
 *     tags: [Stations]
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               name:
 *                 type: string
 *               address:
 *                 type: string
 *               state:
 *                 type: string
 *               lga:
 *                 type: string
 *               location:
 *                 type: object
 *                 properties:
 *                   lat:
 *                     type: number
 *                   lng:
 *                     type: number
 *                 required:
 *                   - lat
 *                   - lng
 *               fuels:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties:
 *                     fuel:
 *                       type: string
 *                     pricePerUnit:
 *                       type: number
 *                   required:
 *                     - fuel
 *                     - pricePerUnit
 *               verified:
 *                 type: boolean
 *               image:
 *                 type: string
 *                 format: binary
 *     responses:
 *       201:
 *         description: Station created
 *       400:
 *         description: Missing required fields
 *       500:
 *         description: Server error
 */
router.post("/", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: "Station image is required" });
    }

    let { name, address, state, lga, location, fuels, verified } = req.body;

    // Validate required fields
    if (!name || !address || !state || !lga || !location || !fuels) {
      return res.status(400).json({ message: "Missing required fields" });
    }

    // Parse location safely
    let locationParsed;
    try {
      locationParsed = typeof location === "string" ? JSON.parse(location) : location;
      if (!locationParsed.lat || !locationParsed.lng) {
        throw new Error("Missing lat or lng in location");
      }
    } catch (err) {
      return res.status(400).json({ message: "Invalid location format" });
    }

    // Parse fuels safely
    let fuelsParsed;
    try {
      fuelsParsed = typeof fuels === "string" ? JSON.parse(fuels) : fuels;
      if (!Array.isArray(fuelsParsed) || fuelsParsed.length === 0) {
        throw new Error("Fuels must be a non-empty array");
      }
      // Validate each fuel object
      fuelsParsed.forEach((f: any) => {
        if (!f.fuel || typeof f.pricePerUnit !== "number") {
          throw new Error("Each fuel must have 'fuel' and numeric 'pricePerUnit'");
        }
      });
    } catch (err) {
      return res.status(400).json({ message: "Invalid fuels format" });
    }

    // Upload image to Cloudinary
    const imageUpload = await new Promise<any>((resolve, reject) => {
      cloudinary.uploader
        .upload_stream(
          { resource_type: "image", folder: "stations" },
          (error, result) => {
            if (error) reject(error);
            else resolve(result);
          }
        )
        .end(req.file!.buffer);
    });

    // Create station
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
    console.error("Error creating station:", err);
    res.status(500).json({ message: "Failed to create station" });
  }
});

// ===================== UPDATE STATION (WITH IMAGE REPLACEMENT) =====================
/**
 * @swagger
 * /api/stations/{id}:
 *   put:
 *     summary: Update a gas station by ID
 *     tags: [Stations]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Station ID
 *     requestBody:
 *       required: false
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               name:
 *                 type: string
 *               address:
 *                 type: string
 *               state:
 *                 type: string
 *               lga:
 *                 type: string
 *               location:
 *                 type: object
 *                 properties:
 *                   lat:
 *                     type: number
 *                   lng:
 *                     type: number
 *               fuels:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties:
 *                     fuel:
 *                       type: string
 *                     price:
 *                       type: number
 *               verified:
 *                 type: boolean
 *               image:
 *                 type: string
 *                 format: binary
 *     responses:
 *       200:
 *         description: Station updated
 *       404:
 *         description: Station not found
 *       500:
 *         description: Server error
 */
router.put("/:id", upload.single("image"), async (req, res) => {
  try {
    const station = await GasStation.findById(req.params.id);
    if (!station) return res.status(404).json({ message: "Station not found" });

    const { name, address, state, lga, location, fuels, verified } = req.body;

    if (req.file && station.image) {
      const publicId = station.image.split("/").pop()?.split(".")[0];
      if (publicId) await cloudinary.uploader.destroy(`stations/${publicId}`);

      const imageUpload = await new Promise<any>((resolve, reject) => {
        cloudinary.uploader
          .upload_stream(
            { resource_type: "image", folder: "stations" },
            (error, result) => (error ? reject(error) : resolve(result))
          )
          .end(req.file!.buffer);
      });

      station.image = imageUpload.secure_url;
    }

    if (name) station.name = name;
    if (address) station.address = address;
    if (state) station.state = state;
    if (lga) station.lga = lga;
    if (location)
      station.location =
        typeof location === "string" ? JSON.parse(location) : location;
    if (fuels) {
      const parsedFuels = typeof fuels === "string" ? JSON.parse(fuels) : fuels;
      if (!Array.isArray(parsedFuels))
        return res.status(400).json({ message: "Invalid fuels format" });
      station.fuels = parsedFuels;
    }
    if (verified !== undefined)
      station.verified = verified === "true" || verified === true;

    await station.save();
    res.json(station);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to update station" });
  }
});

// ===================== DELETE STATION =====================
/**
 * @swagger
 * /api/stations/{id}:
 *   delete:
 *     summary: Delete a gas station by ID
 *     tags: [Stations]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Station ID
 *     responses:
 *       200:
 *         description: Station deleted successfully
 *       404:
 *         description: Station not found
 *       500:
 *         description: Server error
 */
router.delete("/:id", async (req, res) => {
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
    console.error(err);
    res.status(500).json({ message: "Failed to delete station" });
  }
});

export default router;