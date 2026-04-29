import mongoose, { Schema, Document } from "mongoose";

/**
 * Raw Paystack webhook log. Two purposes:
 *   1. Idempotency — `eventId` is unique, so a redelivered webhook is
 *      detected and short-circuited.
 *   2. Replay / debug — the entire payload is preserved verbatim so a
 *      processing bug can be re-run after a fix without asking Paystack
 *      to redeliver.
 */
export interface IWebhookEvent extends Document {
  source: "paystack";
  /** Paystack's event id (data.id from a verified payload). */
  eventId: string;
  event: string;          // e.g. "charge.success"
  payload: unknown;       // raw JSON.parse'd body
  signature: string;      // x-paystack-signature header at receipt time

  processedAt?: Date;
  error?: string;

  createdAt: Date;
  updatedAt: Date;
}

const WebhookEventSchema: Schema<IWebhookEvent> = new Schema(
  {
    source: { type: String, enum: ["paystack"], required: true },
    eventId: { type: String, required: true },
    event: { type: String, required: true },
    payload: { type: Schema.Types.Mixed },
    signature: { type: String, default: "" },
    processedAt: { type: Date },
    error: { type: String },
  },
  { timestamps: true }
);

WebhookEventSchema.index({ source: 1, eventId: 1 }, { unique: true });
WebhookEventSchema.index({ createdAt: -1 });

export default mongoose.model<IWebhookEvent>("WebhookEvent", WebhookEventSchema);
