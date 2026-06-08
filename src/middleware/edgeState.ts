import { Request, Response, NextFunction } from "express";
import { getPlatformConfig } from "../utils/platformConfig";

/**
 * Global edge-state gate. Runs before route handlers and:
 *
 *   1. If maintenanceMode is on, short-circuits with 503 + a
 *      `code: "MAINTENANCE"` body the mobile recognises. /health is
 *      exempt so admin tooling can still ping.
 *
 *   2. Compares the mobile's X-App-Version header against
 *      minMobileVersion. Sub-minimum requests get a 426 + a
 *      `X-Min-Version` response header. Mobile lib/api.ts already
 *      detects this and routes to /states/force-update.
 *
 *   3. On every other response, sets the X-Min-Version header so the
 *      mobile can soft-warn before flipping to the hard 426. Bonus:
 *      this is the cheap "always-on" path — admin can flip the gate
 *      without redeploying because PlatformConfig is mutable.
 *
 * Cached PlatformConfig (60s TTL via utils/platformConfig.ts) so this
 * middleware doesn't hit Mongo on every request.
 */
function compareVersions(a: string, b: string): number {
  const pa = a.split(".");
  const pb = b.split(".");
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const na = parseInt(pa[i] ?? "0", 10);
    const nb = parseInt(pb[i] ?? "0", 10);
    if (Number.isNaN(na) || Number.isNaN(nb)) {
      const cmp = (pa[i] ?? "").localeCompare(pb[i] ?? "");
      if (cmp !== 0) return cmp;
      continue;
    }
    if (na !== nb) return na - nb;
  }
  return 0;
}

const EXEMPT_PATHS = new Set(["/health"]);

export async function edgeStateGate(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  // Path-exempt list bypasses everything.
  if (EXEMPT_PATHS.has(req.path)) {
    next();
    return;
  }

  let cfg;
  try {
    cfg = await getPlatformConfig();
  } catch {
    // If the DB is down we don't want to compound the failure by
    // responding 500 from here — let downstream handlers surface
    // their own errors.
    next();
    return;
  }

  // Maintenance — global short-circuit.
  if (cfg.maintenanceMode) {
    // P0 (audit run 4 model-fields): include the operator-set reason
    // so mobile can render the contextual message admin configured
    // ("Payments provider degraded — back at 14:00") instead of the
    // generic hardcoded copy. The whole purpose of the maintenance
    // kill switch is to communicate WHY during an incident.
    res.status(503).json({
      code: "MAINTENANCE",
      message: cfg.maintenanceReason ?? "We're doing scheduled maintenance.",
      reason: cfg.maintenanceReason ?? undefined,
      expectedBackAt: cfg.maintenanceExpectedBackAt ?? undefined,
    });
    return;
  }

  // Min-version. Always set the header (cheap, lets mobile soft-warn).
  if (cfg.minMobileVersion) {
    res.setHeader("X-Min-Version", cfg.minMobileVersion);

    const clientVersion = req.get("x-app-version");
    if (clientVersion && compareVersions(clientVersion, cfg.minMobileVersion) < 0) {
      res.status(426).json({
        code: "FORCE_UPDATE",
        message: "Update required.",
        minVersion: cfg.minMobileVersion,
      });
      return;
    }
  }

  next();
}
