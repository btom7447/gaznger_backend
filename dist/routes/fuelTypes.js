"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const multer_1 = __importDefault(require("multer"));
const cloudinary_1 = __importDefault(require("../utils/cloudinary"));
const FuelType_1 = __importDefault(require("../models/FuelType"));
const auth_1 = require("../middleware/auth");
const router = (0, express_1.Router)();
const ALLOWED_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"];
const upload = (0, multer_1.default)({
    storage: multer_1.default.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
        if (ALLOWED_MIME_TYPES.includes(file.mimetype)) {
            cb(null, true);
        }
        else {
            cb(new Error("Invalid file type. Only JPEG, PNG, and WebP are allowed."));
        }
    },
});
// GET all fuel types (public)
router.get("/", async (_req, res) => {
    try {
        const fuels = await FuelType_1.default.find({});
        res.status(200).json(fuels);
    }
    catch (err) {
        res.status(500).json({ message: "Failed to fetch fuel types" });
    }
});
// CREATE a new fuel type (admin — requires auth)
router.post("/", auth_1.requireAuth, upload.single("image"), async (req, res) => {
    try {
        const { name, unit } = req.body;
        if (!name)
            return res.status(400).json({ message: "Name is required" });
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
                return res.status(500).json({ message: "Image upload failed" });
            }
        }
        const fuel = await FuelType_1.default.create({
            name,
            unit: unit || "L",
            icon: iconUrl,
        });
        res.status(201).json(fuel);
    }
    catch (err) {
        res.status(500).json({ message: "Failed to create fuel type" });
    }
});
exports.default = router;
//# sourceMappingURL=fuelTypes.js.map