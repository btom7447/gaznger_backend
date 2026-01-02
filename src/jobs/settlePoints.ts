import Point from "../models/Point";
import User from "../models/User";

export async function settlePendingPoints() {
  const now = new Date();

  const pointsToSettle = await Point.find({
    settled: false,
    pendingUntil: { $lte: now },
    $or: [{ expiresAt: { $gte: now } }, { expiresAt: { $exists: false } }],
  });

  for (const point of pointsToSettle) {
    const user = await User.findById(point.user);
    if (!user) continue;

    user.points += point.change;
    if (user.points < 0) user.points = 0;

    await user.save();

    point.settled = true;
    await point.save();
  }
}
