import mongoose, { Schema, Document } from "mongoose";

export interface IRating extends Document {
  user: mongoose.Types.ObjectId;
  station: mongoose.Types.ObjectId;
  order: mongoose.Types.ObjectId;
  score: number;
  comment?: string;
}

const RatingSchema: Schema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: "User", required: true },
    station: { type: Schema.Types.ObjectId, ref: "GasStation", required: true },
    order: { type: Schema.Types.ObjectId, ref: "Order", required: true },
    score: { type: Number, required: true },
    comment: { type: String },
  },
  { timestamps: true }
);

export default mongoose.model<IRating>("Rating", RatingSchema);
