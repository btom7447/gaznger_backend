import { Request, Response, NextFunction } from "express";
import { verifyToken } from "../utils/jwt";

export const requireAuth = (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  const authHeader = req.headers.authorization;
  if (!authHeader)
    return res.status(401).json({ message: "No token provided" });

  const token = authHeader.split(" ")[1]; // Bearer <token>
  const payload = verifyToken(token);
  if (!payload) return res.status(401).json({ message: "Invalid token" });

  // attach user id to request
  (req as any).userId = (payload as any).id;
  next();
};
