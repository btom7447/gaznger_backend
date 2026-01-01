import { setupSwagger } from './swagger';
import express from "express";
import cors from "cors";

import authRoutes from "./routes/auth";
import fuelTypeRoutes from "./routes/fuelTypes";
import stationRoutes from "./routes/stations";
import uploadRoutes from "./routes/upload";

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

// Swagger docs
setupSwagger(app);

export default app;
