import mongoose, { Schema, Document } from "mongoose";

/**
 * Idempotency response cache for auth mutations. Existing
 * money-endpoint dedupe lives at the Transactions level
 * (utils/wallet.ts), but auth mutations don't write a Transaction —
 * we still need replay-safety so a flaky-network retry from mobile
 * with the same Idempotency-Key returns the original 2xx body
 * instead of (a) sending two SMS messages, (b) creating duplicate
 * users, or (c) revoking the just-issued tokens.
 *
 * Lifecycle:
 *   - Handler computes a cache key = `key:${idempotencyKey}:${path}`
 *   - On hit, returns the stored statusCode + body verbatim
 *   - On miss, executes the handler, stores the (statusCode, body),
 *     responds, and Mongo's TTL cleans up after `expiresAt`
 */
export interface IIdempotencyRecord extends Document {
  /** "Idempotency-Key" header value, scoped by path. */
  cacheKey: string;
  /** Response status code. */
  statusCode: number;
  /** Response body (JSON). */
  body: unknown;
  expiresAt: Date;
  createdAt: Date;
}

const IdempotencyRecordSchema: Schema<IIdempotencyRecord> = new Schema(
  {
    cacheKey: { type: String, required: true, unique: true, index: true },
    statusCode: { type: Number, required: true },
    body: { type: Schema.Types.Mixed },
    expiresAt: { type: Date, required: true, index: { expires: 0 } },
  },
  { timestamps: true }
);

export default mongoose.model<IIdempotencyRecord>(
  "IdempotencyRecord",
  IdempotencyRecordSchema
);
