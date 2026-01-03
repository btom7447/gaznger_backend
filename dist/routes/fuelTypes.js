"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const multer_1 = __importDefault(require("multer"));
const cloudinary_1 = __importDefault(require("../utils/cloudinary"));
const FuelType_1 = __importDefault(require("../models/FuelType"));
const router = (0, express_1.Router)();
// ---------------- Multer setup for memory storage ----------------
const storage = multer_1.default.memoryStorage();
const upload = (0, multer_1.default)({ storage });
/**
 * @swagger
 * tags:
 *   - name: FuelTypes
 *     description: Fuel type management
 */
/**
 * @swagger
 * components:
 *   schemas:
 *     FuelType:
 *       type: object
 *       properties:
 *         _id:
 *           type: string
 *           description: Fuel type ID
 *           example: 64c123abc123abc123abc123
 *         name:
 *           type: string
 *           description: Name of the fuel
 *           example: Petrol
 *         unit:
 *           type: string
 *           description: Unit of measurement (L or kg)
 *           example: L
 *         pricePerUnit:
 *           type: number
 *           description: Price per unit
 *           example: 450
 *         icon:
 *           type: string
 *           description: URL of fuel icon image
 *           example: https://res.cloudinary.com/demo/image/upload/v1234567890/petrol.png
 *         createdAt:
 *           type: string
 *           format: date-time
 *         updatedAt:
 *           type: string
 *           format: date-time
 */
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
 *                 $ref: '#/components/schemas/FuelType'
 *       500:
 *         description: Server error
 */
router.get("/", async (_req, res) => {
    try {
        const fuels = await FuelType_1.default.find({});
        res.status(200).json(fuels);
    }
    catch (err) {
        console.error("Fetch fuel types failed:", err);
        res.status(500).json({ message: "Failed to fetch fuel types" });
    }
});
/**
 * @swagger
 * /api/fuel-types:
 *   post:
 *     summary: Create a new fuel type with optional image
 *     tags: [FuelTypes]
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required:
 *               - name
 *               - pricePerUnit
 *             properties:
 *               name:
 *                 type: string
 *                 description: Name of the fuel type
 *                 example: Diesel
 *               unit:
 *                 type: string
 *                 description: Unit of measurement (L or kg)
 *                 example: L
 *               pricePerUnit:
 *                 type: number
 *                 description: Price per unit
 *                 example: 450
 *               image:
 *                 type: string
 *                 format: binary
 *                 description: Optional image file for fuel type
 *     responses:
 *       201:
 *         description: Fuel type created successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/FuelType'
 *       400:
 *         description: Invalid input or fuel type already exists
 *       500:
 *         description: Server error or image upload failed
 */
router.post("/", upload.single("image"), async (req, res) => {
    try {
        const { name, unit, pricePerUnit } = req.body;
        if (!name || !pricePerUnit) {
            return res
                .status(400)
                .json({ message: "Name and pricePerUnit are required" });
        }
        const existing = await FuelType_1.default.findOne({ name });
        if (existing)
            return res.status(400).json({ message: "Fuel type already exists" });
        let iconUrl = undefined;
        if (req.file && req.file.buffer) {
            const streamUpload = () => new Promise((resolve, reject) => {
                const stream = cloudinary_1.default.uploader.upload_stream({ resource_type: "image" }, (error, result) => {
                    if (error)
                        return reject(error);
                    if (!result?.secure_url)
                        return reject(new Error("No URL returned"));
                    resolve(result.secure_url);
                });
                stream.end(req.file.buffer);
            });
            try {
                iconUrl = await streamUpload();
            }
            catch (err) {
                console.error("Cloudinary upload failed:", err);
                return res.status(500).json({ message: "Image upload failed" });
            }
        }
        const fuel = await FuelType_1.default.create({
            name,
            unit: unit || "L",
            pricePerUnit,
            icon: iconUrl,
        });
        res.status(201).json(fuel);
    }
    catch (err) {
        console.error("Create fuel type failed:", err);
        res.status(500).json({ message: "Failed to create fuel type" });
    }
});
exports.default = router;
//# sourceMappingURL=fuelTypes.js.map