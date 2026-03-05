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
import tempPointsRoutes from "./routes/tempPoints";
import addressRoutes from "./routes/address";
import paymentRoutes from "./routes/payments";

import { startCronJobs } from "./jobs";
import { errorHandler } from "./middleware/errorHandler";

const app = express();

// Security headers
app.use(helmet());

// CORS — restrict in production, allow all in development
const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(",");
app.use(
  cors({
    origin:
      process.env.NODE_ENV === "production"
        ? allowedOrigins ?? false
        : true,
    credentials: true,
  })
);

// Request ID on every response
app.use((_req: Request, res: Response, next: NextFunction) => {
  res.setHeader("X-Request-Id", uuidv4());
  next();
});

// Raw body for Paystack webhook signature verification (must be before express.json())
app.use("/api/payments/webhook", express.raw({ type: "application/json" }));

app.use(express.json());

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
app.use("/api/temp", apiLimiter, tempPointsRoutes);
app.use("/api/address-book", apiLimiter, addressRoutes);
app.use("/api/payments", apiLimiter, paymentRoutes);

startCronJobs();

// Swagger docs
setupSwagger(app);

// Global error handler (must be last)
app.use(errorHandler);

export default app;
