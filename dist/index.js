"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
const http_1 = __importDefault(require("http"));
const mongoose_1 = __importDefault(require("mongoose"));
const app_1 = __importDefault(require("./app"));
const db_1 = require("./config/db");
const REQUIRED_ENV_VARS = [
    "MONGO_URI",
    "JWT_SECRET",
    "JWT_REFRESH_SECRET",
    "CLOUDINARY_CLOUD_NAME",
    "CLOUDINARY_API_KEY",
    "CLOUDINARY_API_SECRET",
    "FIREBASE_PROJECT_ID",
    "FIREBASE_PRIVATE_KEY",
    "FIREBASE_CLIENT_EMAIL",
    "RESEND_API_KEY",
];
function validateEnv() {
    const missing = REQUIRED_ENV_VARS.filter((key) => !process.env[key]);
    if (missing.length > 0) {
        throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
    }
}
const PORT = process.env.PORT || 5000;
const startServer = async () => {
    validateEnv();
    await (0, db_1.connectDB)();
    const server = http_1.default.createServer(app_1.default);
    server.listen(PORT, () => {
        console.log(`Server running on port ${PORT}`);
    });
    const shutdown = async (signal) => {
        console.log(`Received ${signal}. Shutting down gracefully...`);
        server.close(async () => {
            await mongoose_1.default.connection.close();
            console.log("Server and DB connections closed.");
            process.exit(0);
        });
    };
    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));
};
startServer();
//# sourceMappingURL=index.js.map