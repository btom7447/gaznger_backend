import mongoose, { Schema, Document } from "mongoose";

/**
 * Immutable record of every state-changing admin action. Wired from the
 * admin route handlers; never edited or deleted. The `before`/`after`
 * snapshots make any mutation auditable end-to-end.
 */
export type AuditAction =
  | "config.update"
  | "user.activate"
  | "user.deactivate"
  | "user.verify"
  | "user.reject"
  | "user.role_change"
  | "user.message"
  | "user.withdrawal_hold.set"
  | "user.withdrawal_hold.clear"
  | "order.refund"
  | "order.refund-retry"
  | "withdrawal.approve"
  | "withdrawal.reject"
  | "withdrawal.retry"
  | "dispute.resolve"
  | "dispute.reject"
  | "dispute.refund-retry"
  | "earning.force_settle"
  | "rider.force_offline"
  | "rider.force_online"
  | "station.verify"
  | "station.unverify"
  | "station.active.set"
  | "station.active.clear";

export interface IAuditLog extends Document {
  actor: mongoose.Types.ObjectId;       // admin user id
  action: AuditAction;
  /** Polymorphic target — User / Order / Withdrawal / Dispute / PlatformConfig id. */
  targetKind: "User" | "Order" | "Withdrawal" | "Dispute" | "PlatformConfig" | "Earning";
  target: mongoose.Types.ObjectId;
  before?: unknown;
  after?: unknown;
  reason?: string;
  ip?: string;
  createdAt: Date;
  updatedAt: Date;
}

const AuditLogSchema: Schema<IAuditLog> = new Schema(
  {
    actor: { type: Schema.Types.ObjectId, ref: "User", required: true },
    action: {
      type: String,
      enum: [
        "config.update",
        "user.activate",
        "user.deactivate",
        "user.verify",
        "user.reject",
        "user.role_change",
        "user.message",
        "user.withdrawal_hold.set",
        "user.withdrawal_hold.clear",
        "order.refund",
        "order.refund-retry",
        "withdrawal.approve",
        "withdrawal.reject",
        "withdrawal.retry",
        "dispute.resolve",
        "dispute.reject",
        "dispute.refund-retry",
        "earning.force_settle",
        "rider.force_offline",
        "rider.force_online",
        "station.verify",
        "station.unverify",
        "station.active.set",
        "station.active.clear",
      ],
      required: true,
    },
    targetKind: {
      type: String,
      enum: ["User", "Order", "Withdrawal", "Dispute", "PlatformConfig", "Earning"],
      required: true,
    },
    target: { type: Schema.Types.ObjectId, required: true },
    before: { type: Schema.Types.Mixed },
    after: { type: Schema.Types.Mixed },
    reason: { type: String },
    ip: { type: String },
  },
  { timestamps: true }
);

AuditLogSchema.index({ actor: 1, createdAt: -1 });
AuditLogSchema.index({ targetKind: 1, target: 1, createdAt: -1 });
AuditLogSchema.index({ action: 1, createdAt: -1 });

export default mongoose.model<IAuditLog>("AuditLog", AuditLogSchema);
