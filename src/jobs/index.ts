import cron from "node-cron";
import { settlePendingPoints } from "./settlePoints";
import { cleanupExpiredPoints } from "./cleanupPoints";
import { dispatchRiders } from "./dispatchRiders";

export function startCronJobs() {
  // Dispatch riders for confirmed orders every minute
  cron.schedule("* * * * *", async () => {
    await dispatchRiders();
  });

  // Settle pending points every 10 minutes
  cron.schedule("*/10 * * * *", async () => {
    await settlePendingPoints();
  });

  // Clean up expired unsettled points daily at midnight
  cron.schedule("0 0 * * *", async () => {
    await cleanupExpiredPoints();
  });
}
