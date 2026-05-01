import mongoose from "mongoose";
import Point from "../models/Point";
import User from "../models/User";

export async function settlePendingPoints() {
  const now = new Date();

  const pointsToSettle = await Point.find({
    settled: false,
    pendingUntil: { $lte: now },
    $or: [{ expiresAt: { $gte: now } }, { expiresAt: { $exists: false } }],
  }).lean();

  if (pointsToSettle.length === 0) return;

  const userTotals: Record<string, number> = {};
  const pointIds: mongoose.Types.ObjectId[] = [];

  for (const point of pointsToSettle) {
    const uid = point.user.toString();
    userTotals[uid] = (userTotals[uid] || 0) + point.change;
    pointIds.push(point._id as mongoose.Types.ObjectId);
  }

  const bulkOps = Object.entries(userTotals).map(([userId, total]) => ({
    updateOne: {
      filter: { _id: new mongoose.Types.ObjectId(userId) },
      update: { $inc: { points: total } },
    },
  }));

  // Plain writes — no session/transaction (M0 Atlas free tier has no
  // replica set, so startSession() buffers forever and times out).
  // Points settlement is low-stakes enough that a partial write on
  // crash is acceptable; the job re-runs every hour and the pending
  // check is idempotent.
  await User.bulkWrite(bulkOps);
  await Point.updateMany(
    { _id: { $in: pointIds } },
    { $set: { settled: true } }
  );
}
