import { Router } from "express";
import multer from "multer";
import cloudinary from "../utils/cloudinary";
import { requireAuth } from "../middleware/auth";
import { uploadImageLimiter, uploadMediaLimiter } from "../middleware/moneyLimiter";

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
  // HEIC/HEIF: bytes 4-11 = "ftypheic" / "ftypheix" / "ftypmif1" / "ftypheis"
  if (buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70) {
    const brand = String.fromCharCode(buf[8], buf[9], buf[10], buf[11]);
    if (brand === "heic" || brand === "heix" || brand === "mif1" || brand === "heis") {
      return true;
    }
  }
  return false;
}

/**
 * SEC-P1 (audit run 5): magic-byte verification for chat media. The
 * /upload/media endpoint pre-fix trusted attacker-controlled MIME
 * headers only — a renamed .exe/.html with `Content-Type: video/mp4`
 * sailed through to Cloudinary, served at our trusted domain
 * (phishing payload hosting + CDN abuse). Now we verify the buffer
 * matches the claimed kind via magic bytes for every accepted format.
 */
function verifyMediaMagicBytes(
  buf: Buffer,
  mime: string,
): "image" | "video" | null {
  if (buf.length < 12) return null;
  if (mime.startsWith("image/")) {
    return verifyImageMagicBytes(buf) ? "image" : null;
  }
  if (mime === "video/mp4") {
    // MP4: bytes 4-7 = "ftyp"
    if (buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70) {
      return "video";
    }
  }
  if (mime === "video/quicktime") {
    // MOV: bytes 4-7 = "ftyp" + brand "qt  " OR "moov"/"mdat" atoms
    if (buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70) {
      return "video";
    }
    if (buf[4] === 0x6d && buf[5] === 0x6f && buf[6] === 0x6f && buf[7] === 0x76) {
      return "video";
    }
  }
  return null;
}

// SEC-P1 (audit run 5): per-user uploadImageLimiter (30/10min) capping
// Cloudinary $-bleed + the OOM risk from 100 concurrent 50MB multer
// buffers. Mounted between requireAuth (so it can key on req.userId)
// and multer (so an over-limit request short-circuits before any
// bytes are buffered).
router.post("/image", requireAuth, uploadImageLimiter, upload.single("image"), async (req, res) => {
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

// ===================== CHAT MEDIA UPLOAD =====================
/**
 * POST /api/upload/media  (field: "media")
 *
 * Image OR video for chat attachments. Larger size cap than profile
 * pics (50 MB) so a short phone-shot video fits. Returns:
 *   { kind, url, thumbUrl, width, height, durationSec?, mime }
 *
 * Cloudinary's resource_type:"auto" detects image vs video from the
 * buffer so we don't have to branch on mime. Videos get a frame-1
 * JPG thumb via `eager` so the chat grid renders instantly without
 * triggering a video decode for the poster.
 */

const CHAT_MIME = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
  "video/mp4",
  "video/quicktime",
];

const chatUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (CHAT_MIME.includes(file.mimetype)) cb(null, true);
    else cb(new Error("Unsupported media type"));
  },
});

// SEC-P1: per-user uploadMediaLimiter (10/10min) — tighter than the
// image limiter because each media upload is up to 50MB.
router.post(
  "/media",
  requireAuth,
  uploadMediaLimiter,
  chatUpload.single("media"),
  async (req: any, res) => {
    try {
      if (!req.file)
        return res.status(400).json({ message: "No file uploaded" });

      // SEC-P1: verify the buffer matches the claimed MIME — closes
      // the "renamed .exe with Content-Type: video/mp4" abuse path.
      const verified = verifyMediaMagicBytes(
        req.file.buffer,
        req.file.mimetype,
      );
      if (!verified) {
        return res.status(400).json({
          message:
            "Unsupported media. Files must be JPEG / PNG / WebP / HEIC images or MP4 / QuickTime video.",
        });
      }

      const isVideo = verified === "video";
      const userId = req.userId;
      const result = await new Promise<any>((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
          {
            // SEC-P1: pin resource_type to what the magic-byte check
            // verified rather than letting Cloudinary auto-detect from
            // a file we now know matches its declared MIME.
            resource_type: isVideo ? "video" : "image",
            folder: `users/${userId}/chat`,
            // For videos, request a frame-1 JPG thumbnail eagerly so
            // the grid renders without decoding the video.
            eager: isVideo
              ? [
                  {
                    format: "jpg",
                    transformation: [
                      { start_offset: "0", width: 480, crop: "limit" },
                    ],
                  },
                ]
              : undefined,
          },
          (error, r) => {
            if (error) reject(error);
            else resolve(r);
          },
        );
        stream.end(req.file!.buffer);
      });

      res.json({
        kind: isVideo ? "video" : "image",
        url: result.secure_url,
        thumbUrl: isVideo
          ? result.eager?.[0]?.secure_url ?? null
          : result.secure_url,
        width: result.width,
        height: result.height,
        durationSec: isVideo ? result.duration ?? null : undefined,
        mime: req.file.mimetype,
      });
    } catch (err) {
      console.error("[upload/media]", err);
      res.status(500).json({ message: "Upload failed" });
    }
  },
);

export default router;
