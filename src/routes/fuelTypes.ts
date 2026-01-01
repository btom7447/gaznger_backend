import { Router } from "express";
import FuelType from "../models/FuelType";

const router = Router();

/**
 * @swagger
 * tags:
 *   name: FuelTypes
 *   description: Fuel type management
 */

// ===================== GET ALL FUEL TYPES =====================
/**
 * @swagger
 * /api/fuel-types:
 *   get:
 *     summary: Get all fuel types
 *     tags: [FuelTypes]
 *     responses:
 *       200:
 *         description: List of fuel types
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   _id:
 *                     type: string
 *                   name:
 *                     type: string
 *                   unit:
 *                     type: string
 *                   pricePerUnit:
 *                     type: number
 *       500:
 *         description: Server error
 */
router.get("/", async (req, res) => {
  try {
    const fuels = await FuelType.find({});
    res.json(fuels);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to fetch fuel types" });
  }
});

// ===================== CREATE NEW FUEL TYPE =====================
/**
 * @swagger
 * /api/fuel-types:
 *   post:
 *     summary: Create a new fuel type (admin/seed)
 *     tags: [FuelTypes]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name, pricePerUnit]
 *             properties:
 *               name:
 *                 type: string
 *                 example: Petrol
 *               unit:
 *                 type: string
 *                 example: L
 *               pricePerUnit:
 *                 type: number
 *                 example: 450
 *     responses:
 *       201:
 *         description: Fuel type created
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 _id:
 *                   type: string
 *                 name:
 *                   type: string
 *                 unit:
 *                   type: string
 *                 pricePerUnit:
 *                   type: number
 *       400:
 *         description: Fuel type already exists
 *       500:
 *         description: Server error
 */
router.post("/", async (req, res) => {
  try {
    const { name, unit, pricePerUnit } = req.body;

    const existing = await FuelType.findOne({ name });
    if (existing)
      return res.status(400).json({ message: "Fuel type already exists" });

    const fuel = await FuelType.create({
      name,
      unit: unit || "L",
      pricePerUnit,
    });

    res.status(201).json(fuel);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to create fuel type" });
  }
});

export default router;
