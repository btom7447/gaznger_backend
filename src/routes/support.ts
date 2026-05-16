import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { getPlatformConfig } from "../utils/platformConfig";

/**
 * Support config surface.
 *
 *   GET /api/support-info?role=customer|vendor|rider
 *
 * Returns the role-scoped support block from PlatformConfig.support so
 * the shared mobile SupportHub renders the same shape for every role
 * but with role-appropriate copy + FAQs.
 *
 * Authenticated to prevent scraping; the response is tiny and changes
 * rarely so it's safe to read on every Profile open.
 */

const router = Router();

router.get("/support-info", requireAuth, async (req: any, res) => {
  try {
    const requested =
      (typeof req.query.role === "string" && req.query.role) ||
      req.user?.role ||
      "customer";
    const role: "customer" | "vendor" | "rider" =
      requested === "vendor" || requested === "rider" ? requested : "customer";

    const cfg = await getPlatformConfig();
    const block = (cfg as any).support?.[role] ?? {
      phone: "",
      email: "",
      hours: "",
      liveChatEnabled: true,
      faqs: [],
    };
    res.json({ role, support: block });
  } catch (err) {
    console.error("[support-info]", err);
    res.status(500).json({ message: "Failed to load support info" });
  }
});

export default router;
