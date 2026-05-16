import mongoose, { Schema, Document } from "mongoose";

/**
 * Chat thread between exactly two participants. Roles are tagged on
 * the participant entry so the client can decide which role-pair the
 * thread is (vendor↔customer, vendor↔rider, rider↔customer, *↔support).
 *
 * One-to-one only. Group chat is a separate feature.
 *
 * Authorization rules baked into the routes layer:
 *
 *   - customer ↔ rider  : allowed only for orders where both
 *                         participants are bound to the same Order.
 *   - customer ↔ vendor : allowed only for orders the customer placed
 *                         at that vendor's station.
 *   - vendor   ↔ rider  : allowed when the rider has delivered (or
 *                         is currently delivering) for the vendor.
 *   - *        ↔ support: always allowed; the "other" participant is
 *                         the dedicated support user (synthesized by
 *                         the server, no human picks).
 *
 * Threads are created lazily — first message creates the row.
 */

export type ChatRole = "customer" | "vendor" | "rider" | "support" | "admin";

export interface ChatParticipant {
  user: mongoose.Types.ObjectId;
  role: ChatRole;
  /** Last time this participant read the thread (any message). */
  lastReadAt?: Date;
  /** Per-participant unread count, maintained server-side on send. */
  unread: number;
}

export interface IChat extends Document {
  /**
   * Sorted [smallerId, largerId] for the participant pair so the
   * deterministic unique index works regardless of who started the
   * thread. Use `Chat.canonicalKey(a, b)` to compute.
   */
  key: string;
  participants: ChatParticipant[];
  /**
   * Optional Order/Bulk/etc. link for thread context. When present,
   * the UI surfaces an order strip above the message list.
   */
  orderRef?: mongoose.Types.ObjectId;
  bulkRef?: mongoose.Types.ObjectId;
  /** Cached for thread-list ordering — set on each new message. */
  lastMessageAt?: Date;
  lastMessagePreview?: string;
  createdAt: Date;
  updatedAt: Date;
}

const ChatParticipantSchema = new Schema<ChatParticipant>(
  {
    user: { type: Schema.Types.ObjectId, ref: "User", required: true },
    role: {
      type: String,
      enum: ["customer", "vendor", "rider", "support", "admin"],
      required: true,
    },
    lastReadAt: { type: Date },
    unread: { type: Number, default: 0 },
  },
  { _id: false },
);

const ChatSchema: Schema = new Schema(
  {
    key: { type: String, required: true, unique: true },
    participants: { type: [ChatParticipantSchema], required: true },
    orderRef: { type: Schema.Types.ObjectId, ref: "Order" },
    bulkRef: { type: Schema.Types.ObjectId, ref: "FuelPlantOrder" },
    lastMessageAt: { type: Date },
    lastMessagePreview: { type: String },
  },
  { timestamps: true },
);

ChatSchema.index({ "participants.user": 1, lastMessageAt: -1 });

/**
 * Canonical key for a participant pair. Sort by string compare so
 * (A, B) and (B, A) produce the same key.
 */
export function canonicalChatKey(
  a: string | mongoose.Types.ObjectId,
  b: string | mongoose.Types.ObjectId,
): string {
  const sa = String(a);
  const sb = String(b);
  return sa < sb ? `${sa}:${sb}` : `${sb}:${sa}`;
}

const Chat = mongoose.model<IChat>("Chat", ChatSchema);
(Chat as any).canonicalKey = canonicalChatKey;
export default Chat;
