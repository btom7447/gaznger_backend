import mongoose from "mongoose";

/**
 * SEC-P2: Safely coerce a user-supplied string into a Mongoose ObjectId.
 *
 * `new mongoose.Types.ObjectId(badInput)` throws a CastError that bubbles
 * up as a generic 500 — callers should validate first and reply 400 on
 * null. Accepts strings or ObjectId-likes; returns null when the input
 * cannot be cast safely.
 */
export function toObjectId(
  input: unknown,
): mongoose.Types.ObjectId | null {
  if (input === undefined || input === null) return null;
  if (input instanceof mongoose.Types.ObjectId) return input;
  if (typeof input !== "string" && typeof input !== "number") return null;
  const str = String(input);
  if (!mongoose.isValidObjectId(str)) return null;
  return new mongoose.Types.ObjectId(str);
}
