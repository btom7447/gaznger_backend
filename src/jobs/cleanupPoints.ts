import Point from "../models/Point";

export async function cleanupExpiredPoints() {
  const now = new Date();
  const result = await Point.deleteMany({
    expiresAt: { $lt: now },
    settled: false,
  });
  console.log(`Deleted ${result.deletedCount} expired unsettled points`);
}
