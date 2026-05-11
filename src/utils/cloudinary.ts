import { v2 as cloudinary } from "cloudinary";

// env is loaded by src/index.ts (only in dev) — no need to re-call
// dotenv.config() here. On Railway it printed a confusing
// "[dotenv] injecting env (0) from .env" line every boot.

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

export default cloudinary;
