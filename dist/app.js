"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const swagger_1 = require("./swagger");
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const helmet_1 = __importDefault(require("helmet"));
const express_rate_limit_1 = __importDefault(require("express-rate-limit"));
const uuid_1 = require("uuid");
const auth_1 = __importDefault(require("./routes/auth"));
const fuelTypes_1 = __importDefault(require("./routes/fuelTypes"));
const stations_1 = __importDefault(require("./routes/stations"));
const upload_1 = __importDefault(require("./routes/upload"));
const points_1 = __importDefault(require("./routes/points"));
const orders_1 = __importDefault(require("./routes/orders"));
const notifications_1 = __importDefault(require("./routes/notifications"));
const address_1 = __importDefault(require("./routes/address"));
const payments_1 = __importDefault(require("./routes/payments"));
const jobs_1 = require("./jobs");
const errorHandler_1 = require("./middleware/errorHandler");
const app = (0, express_1.default)();
// Security headers
app.use((0, helmet_1.default)());
// CORS — restrict in production, allow all in development
const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(",");
app.use((0, cors_1.default)({
    origin: process.env.NODE_ENV === "production"
        ? allowedOrigins ?? false
        : true,
    credentials: true,
}));
// Request ID on every response
app.use((_req, res, next) => {
    res.setHeader("X-Request-Id", (0, uuid_1.v4)());
    next();
});
// Raw body for Paystack webhook signature verification (must be before express.json())
app.use("/api/payments/webhook", express_1.default.raw({ type: "application/json" }));
app.use(express_1.default.json());
// Rate limiters
const authLimiter = (0, express_rate_limit_1.default)({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 10,
    message: { message: "Too many requests, please try again later." },
    standardHeaders: true,
    legacyHeaders: false,
});
const apiLimiter = (0, express_rate_limit_1.default)({
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
app.use("/auth", authLimiter, auth_1.default);
app.use("/api/fuel-types", apiLimiter, fuelTypes_1.default);
app.use("/api/stations", apiLimiter, stations_1.default);
app.use("/api/upload", apiLimiter, upload_1.default);
app.use("/api/points", apiLimiter, points_1.default);
app.use("/api/orders", apiLimiter, orders_1.default);
app.use("/api/notifications", apiLimiter, notifications_1.default);
app.use("/api/address-book", apiLimiter, address_1.default);
app.use("/api/payments", apiLimiter, payments_1.default);
(0, jobs_1.startCronJobs)();
// Swagger docs
(0, swagger_1.setupSwagger)(app);
// Global error handler (must be last)
app.use(errorHandler_1.errorHandler);
exports.default = app;
//# sourceMappingURL=app.js.map