import mongoose, { Schema, Document } from "mongoose";

export interface IPoint extends Document {
  user: mongoose.Types.ObjectId;
  change: number;
  type: "earn" | "redeem" | "adjust";
  description?: string;
  pendingUntil?: Date; 
  expiresAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const PointSchema: Schema<IPoint> = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: "User", required: true },
    change: { type: Number, required: true },
    type: { type: String, enum: ["earn", "redeem", "adjust"], default: "earn" },
    description: { type: String, default: "" },
    pendingUntil: { type: Date }, 
    expiresAt: { type: Date },
  },
  { timestamps: true }
);

export default mongoose.model<IPoint>("Point", PointSchema);
