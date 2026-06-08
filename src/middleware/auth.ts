import { Request, Response, NextFunction } from "express";
import { verifyToken } from "../utils/jwt";
import User from "../models/User";

/**
 * SEC-P1 (audit run 5): cached tokenVersion lookup.
 *
 * Closes the 15-min post-revoke window. Every access JWT now carries
 * a `v` claim (the user's tokenVersion at sign-time); requireAuth
 * looks up the current value and rejects if the JWT's claim is below
 * it. Bumped on logout, refresh-token-reuse detection, account
 * suspension, and account deletion (see bumpTokenVersion in
 * utils/auth.ts).
 *
 * 30s cache so the happy path doesn't pay a DB roundtrip per request.
 * Negative results aren't cached — re-issuing a valid JWT after
 * reinstatement (tokenVersion bump) lets the user back in immediately.
 */
const tokenVersionCache = new Map<string, { v: number; expiresAt: number }>();
const TOKEN_VERSION_TTL_MS = 30_000;

async function getCachedTokenVersion(userId: string): Promise<number | null> {
  const now = Date.now();
  const hit = tokenVersionCache.get(userId);
  if (hit && hit.expiresAt > now) return hit.v;
  try {
    const user = await User.findById(userId).select("tokenVersion").lean();
    if (!user) return null;
    const v = (user as any).tokenVersion ?? 0;
    tokenVersionCache.set(userId, { v, expiresAt: now + TOKEN_VERSION_TTL_MS });
    return v;
  } catch {
    // DB hiccup — fail open so a transient outage doesn't lock
    // every legitimate user out. The next request re-checks.
    return null;
  }
}

/**
 * Invalidate the cached tokenVersion for a user so the next request
 * re-reads from DB. Called from bumpTokenVersion in utils/auth.ts
 * after the User.tokenVersion write succeeds.
 */
export function invalidateTokenVersionCache(userId: string): void {
  tokenVersionCache.delete(userId);
}

export const requireAuth = async (
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

  const payload = verifyToken(token) as
    | { id?: string; v?: number }
    | null;
  if (!payload || !payload.id)
    return res.status(401).json({ message: "Invalid token" });

  // SEC-P1: tokenVersion check. Tokens minted before this field
  // existed have no `v` claim — treat as 0 and accept if current
  // version is 0 (i.e. the user hasn't been revoked since the
  // upgrade). Tokens signed AFTER the upgrade always carry a `v`.
  const jwtVersion = payload.v ?? 0;
  const currentVersion = await getCachedTokenVersion(payload.id);
  if (currentVersion != null && jwtVersion < currentVersion) {
    return res.status(401).json({
      code: "session_revoked",
      message: "Your session has been revoked. Please sign in again.",
    });
  }

  req.userId = payload.id;
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

/**
 * SECURITY X8 / BUSINESS_RULES P0-1 — vendor-side gate that also
 * enforces verification. Use on ANY route that mutates customer-
 * facing state (order accept/confirm/reject, station price
 * updates, etc.). Mobile gates navigation on
 * `verificationStatus === "approved"` already; this middleware is
 * the server-side mirror so a mid-session demotion or a direct API
 * call can't bypass.
 *
 * Treats vendorVerification.status as the source of truth (admin
 * tooling reads + writes that field). User.verificationStatus is
 * the legacy field; kept for rider parity but not authoritative
 * for vendors.
 */
export const requireVerifiedVendor = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  if (!req.userId)
    return res.status(401).json({ message: "Unauthorized" });

  const user = await User.findById(req.userId)
    .select("role vendorVerification verificationStatus")
    .lean();
  if (!user || user.role !== "vendor")
    return res.status(403).json({ message: "Vendor access required" });

  const vendorStatus =
    (user as any).vendorVerification?.status ?? user.verificationStatus;
  if (vendorStatus !== "verified" && vendorStatus !== "approved") {
    return res.status(403).json({
      message:
        "Your vendor account isn't verified yet. Complete KYC to perform this action.",
      code: "vendor_not_verified",
    });
  }

  next();
};
