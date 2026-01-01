import { Router } from "express";
import GasStation from "../models/Station";

const router = Router();

/**
 * @swagger
 * tags:
 *   name: Stations
 *   description: Gas station management
 */

// ===================== GET ALL STATIONS =====================
/**
 * @swagger
 * /api/stations:
 *   get:
 *     summary: Get all gas stations with optional filters
 *     tags: [Stations]
 *     parameters:
 *       - in: query
 *         name: verified
 *         schema:
 *           type: boolean
 *         description: Filter by verified stations
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
 *         description: Radius in km
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
 *     summary: Get a single station by ID
 *     tags: [Stations]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
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
 *     summary: Create a new gas station (admin/seed)
 *     tags: [Stations]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name, address, state, lga, location, fuels]
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
 *                     pricePerUnit:
 *                       type: number
 *               verified:
 *                 type: boolean
 *                 default: false
 *     responses:
 *       201:
 *         description: Station created
 *       500:
 *         description: Server error
 */
router.post("/", async (req, res) => {
  try {
    const { name, address, state, lga, location, fuels, verified } = req.body;

    const station = await GasStation.create({
      name,
      address,
      state,
      lga,
      location,
      fuels,
      verified: verified || false,
    });

    res.status(201).json(station);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to create station" });
  }
});

export default router;