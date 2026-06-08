import { Router } from "express";
import { getPlatformConfig } from "../utils/platformConfig";

/**
 * Public platform config.
 *
 * P1-MF-7 (audit run 4 model-fields) + P0-6: mobile clients need to
 * read the user-facing subset of PlatformConfig BEFORE every request
 * (kill-switch UX) and DURING bootstrap (feature flags + minimum
 * version). Pre-fix, the only config endpoint was `/api/admin/config`
 * which requires admin auth — mobile couldn't reach it. As a result
 * the maintenance kill switch, payment kill switch, withdraw kill
 * switch, signup kill switch, order-placement kill switch, and
 * dispatch kill switch were all settable in admin but ignored by
 * mobile (and by server middleware — see the gates in orders.ts,
 * auth.ts signup, dispatchRiders.ts).
 *
 * This endpoint returns ONLY the fields a public client may safely
 * read. Admin-only fields (commission rates, fee structures) stay
 * gated behind `/api/admin/config`.
 */
const router = Router();

router.get("/", async (_req, res) => {
  try {
    const cfg = await getPlatformConfig();
    res.json({
      // Edge / kill switches
      maintenanceMode: cfg.maintenanceMode ?? false,
      maintenanceReason: cfg.maintenanceReason ?? null,
      maintenanceExpectedBackAt: cfg.maintenanceExpectedBackAt ?? null,
      // Feature gates — surfaced so mobile can disable the relevant
      // CTA pre-emptively rather than letting the request 503.
      paymentsEnabled: cfg.paymentsEnabled ?? true,
      withdrawalsEnabled: cfg.withdrawalsEnabled ?? true,
      orderPlacementEnabled: (cfg as any).orderPlacementEnabled ?? true,
      dispatchEnabled: (cfg as any).dispatchEnabled ?? true,
      signupsEnabled: (cfg as any).signupsEnabled ?? true,
      // Versioning
      minMobileVersion: cfg.minMobileVersion ?? null,
      // Support contact — surfaced so the mobile "Contact support"
      // CTA can reach a live email/phone without a bundled fallback.
      support: cfg.support
        ? {
            email: (cfg.support as any).email,
            phone: (cfg.support as any).phone,
            whatsappUrl: (cfg.support as any).whatsappUrl,
          }
        : null,
    });
  } catch (err) {
    console.error("[/api/config]", err);
    res.status(500).json({ message: "Failed to load config" });
  }
});

export default router;
