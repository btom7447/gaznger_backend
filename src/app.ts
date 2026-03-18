import { setupSwagger } from "./swagger";
import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { v4 as uuidv4 } from "uuid";

import authRoutes from "./routes/auth";
import fuelTypeRoutes from "./routes/fuelTypes";
import stationRoutes from "./routes/stations";
import uploadRoutes from "./routes/upload";
import pointRoutes from "./routes/points";
import orderRoutes from "./routes/orders";
import notificationRoutes from "./routes/notifications";
import addressRoutes from "./routes/address";
import paymentRoutes from "./routes/payments";
import vendorRoutes from "./routes/vendor";
import riderRoutes from "./routes/rider";
import adminRoutes from "./routes/admin";

import { startCronJobs } from "./jobs";
import { errorHandler } from "./middleware/errorHandler";

const app = express();

// Security headers
app.use(helmet());

// CORS — restrict to allowed origins in production, allow all in development
const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(",").map((o) => o.trim());

app.use(
  cors({
    origin:
      process.env.NODE_ENV === "production"
        ? (origin, callback) => {
            // allow requests with no origin (mobile apps, curl, etc.)
            if (!origin) return callback(null, true);
            if (allowedOrigins && allowedOrigins.includes(origin)) {
              return callback(null, true);
            }
            callback(new Error(`CORS: origin ${origin} not allowed`));
          }
        : true,
    credentials: true,
  }),
);

// Request ID on every response
app.use((_req: Request, res: Response, next: NextFunction) => {
  res.setHeader("X-Request-Id", uuidv4());
  next();
});

// Raw body for Paystack webhook signature verification (must be before express.json())
app.use("/api/payments/webhook", express.raw({ type: "application/json" }));

app.use(express.json());

// Strip MongoDB operator injection ($-prefixed keys) from user input
function sanitizeObject(obj: unknown): unknown {
  if (Array.isArray(obj)) return obj.map(sanitizeObject);
  if (obj !== null && typeof obj === "object") {
    return Object.fromEntries(
      Object.entries(obj as Record<string, unknown>)
        .filter(([key]) => !key.startsWith("$"))
        .map(([key, val]) => [key, sanitizeObject(val)])
    );
  }
  return obj;
}

app.use((req: Request, _res: Response, next: NextFunction) => {
  if (req.body) req.body = sanitizeObject(req.body);
  if (req.query) req.query = sanitizeObject(req.query) as typeof req.query;
  next();
});

// Rate limiters
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  message: { message: "Too many requests, please try again later." },
  standardHeaders: true,
  legacyHeaders: false,
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 100,
  message: { message: "Too many requests, please try again later." },
  standardHeaders: true,
  legacyHeaders: false,
});

// Health check (no auth, no rate limit)
app.get("/health", (_req, res) => {
  res.json({ status: "ok", uptime: process.uptime() });
});

// Routes
app.use("/auth", authLimiter, authRoutes);
app.use("/api/fuel-types", apiLimiter, fuelTypeRoutes);
app.use("/api/stations", apiLimiter, stationRoutes);
app.use("/api/upload", apiLimiter, uploadRoutes);
app.use("/api/points", apiLimiter, pointRoutes);
app.use("/api/orders", apiLimiter, orderRoutes);
app.use("/api/notifications", apiLimiter, notificationRoutes);
app.use("/api/address-book", apiLimiter, addressRoutes);
app.use("/api/payments", apiLimiter, paymentRoutes);
app.use("/api/vendor", apiLimiter, vendorRoutes);
app.use("/api/rider", apiLimiter, riderRoutes);
app.use("/api/admin", apiLimiter, adminRoutes);

startCronJobs();

// Swagger docs
setupSwagger(app);

// Global error handler (must be last)
app.use(errorHandler);

export default app;
