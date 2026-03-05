import cron from "node-cron";
import { settlePendingPoints } from "./settlePoints";
import { cleanupExpiredPoints } from "./cleanupPoints";

export function startCronJobs() {
  // Settle pending points every 10 minutes
  cron.schedule("*/10 * * * *", async () => {
    console.log("Running point settlement job...");
    await settlePendingPoints();
  });

  // Clean up expired unsettled points daily at midnight
  cron.schedule("0 0 * * *", async () => {
    console.log("Running expired points cleanup job...");
    await cleanupExpiredPoints();
  });
}
