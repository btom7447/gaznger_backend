"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const swagger_1 = require("./swagger");
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const auth_1 = __importDefault(require("./routes/auth"));
const fuelTypes_1 = __importDefault(require("./routes/fuelTypes"));
const stations_1 = __importDefault(require("./routes/stations"));
const upload_1 = __importDefault(require("./routes/upload"));
const points_1 = __importDefault(require("./routes/points"));
const orders_1 = __importDefault(require("./routes/orders"));
const notifications_1 = __importDefault(require("./routes/notifications"));
const jobs_1 = require("./jobs");
const app = (0, express_1.default)();
// Middleware
app.use((0, cors_1.default)({
    origin: "*",
}));
app.use(express_1.default.json());
app.use("/auth", auth_1.default);
app.use("/api/fuel-types", fuelTypes_1.default);
app.use("/api/stations", stations_1.default);
app.use("/api/upload", upload_1.default);
app.use("/api/points", points_1.default);
app.use("/api/orders", orders_1.default);
app.use("/api/notifications", notifications_1.default);
(0, jobs_1.startCronJobs)();
// Swagger docs
(0, swagger_1.setupSwagger)(app);
exports.default = app;
//# sourceMappingURL=app.js.map