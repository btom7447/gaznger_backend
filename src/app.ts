import { setupSwagger } from './swagger';
import express from "express";
import cors from "cors";

import authRoutes from "./routes/auth";
import fuelTypeRoutes from "./routes/fuelTypes";
import stationRoutes from "./routes/stations";
import uploadRoutes from "./routes/upload";
import pointRoutes from "./routes/points";
import orderRoutes from "./routes/orders";
import notificationRoutes from "./routes/notifications"; 
import tempPointsRoutes from "./routes/tempPoints";

import { startCronJobs } from './jobs';

const app = express();

// Middleware
app.use(cors({
    origin: "*",
}));
app.use(express.json());
app.use("/auth", authRoutes);
app.use("/api/fuel-types", fuelTypeRoutes);
app.use("/api/stations", stationRoutes);
app.use("/api/upload", uploadRoutes);
app.use("/api/points", pointRoutes);
app.use("/api/orders", orderRoutes);
app.use("/api/notifications", notificationRoutes);
app.use("/api/temp", tempPointsRoutes);

startCronJobs();

// Swagger docs
setupSwagger(app);

export default app;
