"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.requireCustomer = exports.requireRider = exports.requireVendor = exports.requireAdmin = exports.requireAuth = void 0;
const jwt_1 = require("../utils/jwt");
const User_1 = __importDefault(require("../models/User"));
const requireAuth = (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader)
        return res.status(401).json({ message: "No token provided" });
    const token = authHeader.split(" ")[1]; // Bearer <token>
    const payload = (0, jwt_1.verifyToken)(token);
    if (!payload)
        return res.status(401).json({ message: "Invalid token" });
    req.userId = payload.id;
    next();
};
exports.requireAuth = requireAuth;
const requireAdmin = async (req, res, next) => {
    if (!req.userId)
        return res.status(401).json({ message: "Unauthorized" });
    const user = await User_1.default.findById(req.userId).select("role").lean();
    if (!user || user.role !== "admin")
        return res.status(403).json({ message: "Admin access required" });
    next();
};
exports.requireAdmin = requireAdmin;
const requireVendor = async (req, res, next) => {
    if (!req.userId)
        return res.status(401).json({ message: "Unauthorized" });
    const user = await User_1.default.findById(req.userId).select("role").lean();
    if (!user || user.role !== "vendor")
        return res.status(403).json({ message: "Vendor access required" });
    next();
};
exports.requireVendor = requireVendor;
const requireRider = async (req, res, next) => {
    if (!req.userId)
        return res.status(401).json({ message: "Unauthorized" });
    const user = await User_1.default.findById(req.userId).select("role").lean();
    if (!user || user.role !== "rider")
        return res.status(403).json({ message: "Rider access required" });
    next();
};
exports.requireRider = requireRider;
const requireCustomer = async (req, res, next) => {
    if (!req.userId)
        return res.status(401).json({ message: "Unauthorized" });
    const user = await User_1.default.findById(req.userId).select("role").lean();
    if (!user || user.role !== "customer")
        return res.status(403).json({ message: "Customer access required" });
    next();
};
exports.requireCustomer = requireCustomer;
//# sourceMappingURL=auth.js.map