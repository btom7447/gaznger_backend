import { Request, Response, NextFunction } from "express";
import { verifyToken } from "../utils/jwt";
import User from "../models/User";

export const requireAuth = (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  const authHeader = req.headers.authorization;
  if (!authHeader)
    return res.status(401).json({ message: "No token provided" });

  // SECURITY (audit E.2): require the literal "Bearer " prefix. Without
  // this check, `authHeader.split(" ")[1]` happily parses
  // "Basic <token>" or just "<token>" and verifyToken sees a value the
  // caller never legitimately sent. Generic 401 in either case.
  if (!authHeader.startsWith("Bearer "))
    return res.status(401).json({ message: "Invalid token" });

  const token = authHeader.slice(7).trim();
  if (!token) return res.status(401).json({ message: "Invalid token" });

  const payload = verifyToken(token);
  if (!payload) return res.status(401).json({ message: "Invalid token" });

  req.userId = (payload as any).id;
  next();
};

export const requireAdmin = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  if (!req.userId)
    return res.status(401).json({ message: "Unauthorized" });

  const user = await User.findById(req.userId).select("role").lean();
  if (!user || user.role !== "admin")
    return res.status(403).json({ message: "Admin access required" });

  next();
};

export const requireVendor = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  if (!req.userId)
    return res.status(401).json({ message: "Unauthorized" });

  const user = await User.findById(req.userId).select("role").lean();
  if (!user || user.role !== "vendor")
    return res.status(403).json({ message: "Vendor access required" });

  next();
};

export const requireRider = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  if (!req.userId)
    return res.status(401).json({ message: "Unauthorized" });

  const user = await User.findById(req.userId).select("role").lean();
  if (!user || user.role !== "rider")
    return res.status(403).json({ message: "Rider access required" });

  next();
};

export const requireCustomer = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  if (!req.userId)
    return res.status(401).json({ message: "Unauthorized" });

  const user = await User.findById(req.userId).select("role").lean();
  if (!user || user.role !== "customer")
    return res.status(403).json({ message: "Customer access required" });

  next();
};
