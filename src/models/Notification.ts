import mongoose, { Schema, Document } from "mongoose";

export type NotificationType =
  | "order"
  | "payment"
  | "delivery"
  | "delivered"
  | "cancelled"
  | "points"
  | "promo"
  | "system"
  | "alert"
  | "message"
  // Account / lifecycle (admin actions: activate, suspend, verify, message)
  | "account"
  // Vendor-specific
  | "new_order"
  // Rider-specific
  | "dispatch"
  | "earnings";

export interface INotification extends Document {
  user: mongoose.Types.ObjectId;
  type: NotificationType;
  title: string;
  body: string;
  read: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const NotificationSchema: Schema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: "User", required: true },
    type: {
      type: String,
      enum: ["order", "payment", "delivery", "delivered", "cancelled", "points", "promo", "system", "alert", "message", "account", "new_order", "dispatch", "earnings"],
      required: true,
    },
    title: { type: String, required: true },
    body: { type: String, required: true },
    read: { type: Boolean, default: false },
  },
  { timestamps: true }
);

NotificationSchema.index({ user: 1, read: 1 });

export default mongoose.model<INotification>("Notification", NotificationSchema);
