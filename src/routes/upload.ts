import { Router } from "express";
import multer from "multer";
import cloudinary from "../utils/cloudinary";
import { requireAuth } from "../middleware/auth";

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

// SECURITY (audit E.1): mime-type from the multipart header is attacker-
// controlled. A renamed `.exe` will still pass `fileFilter` if the client
// claims `image/jpeg`. Verify the buffer's leading magic bytes match a
// known image format before sending to Cloudinary.
function verifyImageMagicBytes(buf: Buffer): boolean {
  if (buf.length < 12) return false;
  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true;
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  )
    return true;
  // WebP: "RIFF" .... "WEBP"
  if (
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  )
    return true;
  return false;
}

router.post("/image", requireAuth, upload.single("image"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: "No file uploaded" });

    if (!verifyImageMagicBytes(req.file.buffer)) {
      return res
        .status(400)
        .json({ message: "Invalid image. Only JPEG, PNG, and WebP are allowed." });
    }

    const userId = req.userId;
    const uploadResult = await new Promise<any>((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          resource_type: "image",
          // Pin uploads under per-user folder so cross-tenant ID
          // collisions can't overwrite someone else's image.
          folder: `users/${userId}`,
        },
        (error, result) => {
          if (error) reject(error);
          else resolve(result);
        }
      );
      stream.end(req.file!.buffer);
    });

    res.json({ url: uploadResult.secure_url });
  } catch (err: any) {

    res.status(500).json({ message: "Upload failed" });
  }
});

export default router;
