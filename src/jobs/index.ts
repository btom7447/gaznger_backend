import cron from "node-cron";
import { settlePendingPoints } from "./settlePoints";

export function startCronJobs() {
  cron.schedule("*/10 * * * *", async () => {
    console.log("Running point settlement job...");
    await settlePendingPoints();
  });
}
