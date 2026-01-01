"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.requireAuth = void 0;
const jwt_1 = require("../utils/jwt");
const requireAuth = (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader)
        return res.status(401).json({ message: "No token provided" });
    const token = authHeader.split(" ")[1]; // Bearer <token>
    const payload = (0, jwt_1.verifyToken)(token);
    if (!payload)
        return res.status(401).json({ message: "Invalid token" });
    // attach user id to request
    req.userId = payload.id;
    next();
};
exports.requireAuth = requireAuth;
//# sourceMappingURL=auth.js.map