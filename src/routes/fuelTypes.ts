import { Router, Request, Response } from "express";
import multer from "multer";
import cloudinary from "../utils/cloudinary";
import FuelType from "../models/FuelType";
import { requireAuth, requireAdmin } from "../middleware/auth";

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

// GET all fuel types (public)
router.get("/", async (_req: Request, res: Response) => {
  try {
    const fuels = await FuelType.find({});
    res.status(200).json(fuels);
  } catch (err) {

    res.status(500).json({ message: "Failed to fetch fuel types" });
  }
});

// CREATE a new fuel type — admin only.
// SEC-P1 (audit run 5): pre-fix the comment said "admin — requires
// auth" but only requireAuth was enforced, so any authenticated user
// (including a fresh customer signup) could create FuelType rows +
// upload arbitrary images to the shared Cloudinary folder, polluting
// the catalog read by orders.ts and fuelPrices.ts. Now requireAdmin
// per the comment's original intent.
router.post("/", requireAuth, requireAdmin, upload.single("image"), async (req: Request, res: Response) => {
  try {
    const { name, unit } = req.body;

    if (!name)
      return res.status(400).json({ message: "Name is required" });

    const existing = await FuelType.findOne({ name });
    if (existing)
      return res.status(400).json({ message: "Fuel type already exists" });

    let iconUrl: string | undefined = undefined;
    if (req.file && req.file.buffer) {
      const streamUpload = () =>
        new Promise<string>((resolve, reject) => {
          const stream = cloudinary.uploader.upload_stream(
            { resource_type: "image" },
            (error, result) => {
              if (error) return reject(error);
              if (!result?.secure_url) return reject(new Error("No URL returned"));
              resolve(result.secure_url);
            }
          );
          stream.end(req.file!.buffer);
        });

      try {
        iconUrl = await streamUpload();
      } catch (err: any) {

        return res.status(500).json({ message: "Image upload failed" });
      }
    }

    const fuel = await FuelType.create({
      name,
      unit: unit || "L",
      icon: iconUrl,
    });

    res.status(201).json(fuel);
  } catch (err) {

    res.status(500).json({ message: "Failed to create fuel type" });
  }
});

export default router;
