import { Router } from "express";
import multer from "multer";
import cloudinary from "../utils/cloudinary";
import { Express } from "express";

const router = Router();

// Multer setup for memory storage (buffer)
const storage = multer.memoryStorage();
const upload = multer({ storage });

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
    if (!req.file) return res.status(400).json({ message: "No file uploaded" });

    const fileBuffer = req.file.buffer;

    const uploadResult = await new Promise<any>((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        { resource_type: "image" },
        (error, result) => {
          if (error) reject(error);
          else resolve(result);
        }
      );
      stream.end(fileBuffer); // pipe buffer into the Cloudinary stream
    });

    res.json({ url: uploadResult.secure_url });
  } catch (err: any) {
    console.error(err);
    res.status(500).json({ message: err.message || "Upload failed" });
  }
});


export default router;
