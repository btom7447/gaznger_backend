import { Router } from "express";
import { settlePendingPoints } from "../jobs/settlePoints";

const router = Router();

/**
 * TEMP ROUTE: Settle all pending points immediately
 * Usage: curl -X POST http://localhost:3000/api/temp/settle-points
 */
router.post("/settle-points", async (req, res) => {
  try {
    await settlePendingPoints();
    res.json({ message: "All pending points have been settled" });
  } catch (err) {
    console.error("Error settling points:", err);
    res.status(500).json({ message: "Failed to settle points" });
  }
});

export default router;
