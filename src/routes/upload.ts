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
router.post(
  "/image",
  upload.single("image"),
  async (req: Express.Request, res) => {
    try {
      if (!req.file)
        return res.status(400).json({ message: "No file uploaded" });

      const result = await cloudinary.uploader.upload_stream(
        { resource_type: "image" },
        (error, result) => {
          if (error) return res.status(500).json({ message: error.message });
          res.json({ url: result?.secure_url });
        }
      );

      // Pipe file buffer to Cloudinary
      if (req.file.buffer) {
        const stream = result as any;
        stream.end(req.file.buffer);
      }
    } catch (err: any) {
      console.error(err);
      res.status(500).json({ message: "Upload failed" });
    }
  }
);

export default router;
