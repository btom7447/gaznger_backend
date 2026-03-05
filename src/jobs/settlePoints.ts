import mongoose from "mongoose";
import Point from "../models/Point";
import User from "../models/User";

export async function settlePendingPoints() {
  const now = new Date();
  const session = await mongoose.startSession();

  try {
    session.startTransaction();

    const pointsToSettle = await Point.find({
      settled: false,
      pendingUntil: { $lte: now },
      $or: [{ expiresAt: { $gte: now } }, { expiresAt: { $exists: false } }],
    }).lean();

    if (pointsToSettle.length === 0) {
      await session.abortTransaction();
      return;
    }

    // Group changes by user
    const userTotals: Record<string, number> = {};
    const pointIds: mongoose.Types.ObjectId[] = [];

    for (const point of pointsToSettle) {
      const uid = point.user.toString();
      userTotals[uid] = (userTotals[uid] || 0) + point.change;
      pointIds.push(point._id as mongoose.Types.ObjectId);
    }

    // Bulk update user point balances
    const bulkOps = Object.entries(userTotals).map(([userId, total]) => ({
      updateOne: {
        filter: { _id: new mongoose.Types.ObjectId(userId) },
        update: { $inc: { points: total } },
      },
    }));

    await User.bulkWrite(bulkOps, { session });

    // Mark all as settled in one query
    await Point.updateMany(
      { _id: { $in: pointIds } },
      { $set: { settled: true } },
      { session }
    );

    await session.commitTransaction();
  } catch (err) {
    await session.abortTransaction();
  } finally {
    session.endSession();
  }
}
