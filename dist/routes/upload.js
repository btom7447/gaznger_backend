"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const multer_1 = __importDefault(require("multer"));
const cloudinary_1 = __importDefault(require("../utils/cloudinary"));
const router = (0, express_1.Router)();
// Multer setup for memory storage (buffer)
const storage = multer_1.default.memoryStorage();
const upload = (0, multer_1.default)({ storage });
/**
 * @swagger
 * tags:
 *   name: Upload
 *   description: Image upload endpoints
 */
/**
 * @swagger
 * /api/upload/image:
 *   post:
 *     summary: Upload an image to Cloudinary
 *     tags: [Upload]
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               image:
 *                 type: string
 *                 format: binary
 *     responses:
 *       200:
 *         description: Image uploaded successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 url:
 *                   type: string
 *                   example: "https://res.cloudinary.com/demo/image/upload/v1234567890/sample.jpg"
 *       400:
 *         description: No file uploaded
 *       500:
 *         description: Server error
 */
router.post("/image", upload.single("image"), async (req, res) => {
    try {
        if (!req.file)
            return res.status(400).json({ message: "No file uploaded" });
        const result = await cloudinary_1.default.uploader.upload_stream({ resource_type: "image" }, (error, result) => {
            if (error)
                return res.status(500).json({ message: error.message });
            res.json({ url: result?.secure_url });
        });
        // Pipe file buffer to Cloudinary
        if (req.file.buffer) {
            const stream = result;
            stream.end(req.file.buffer);
        }
    }
    catch (err) {
        console.error(err);
        res.status(500).json({ message: "Upload failed" });
    }
});
exports.default = router;
