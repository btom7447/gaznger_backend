import mongoose, { Schema, Document } from "mongoose";

export interface IBankAccount {
  bankName: string;
  accountNumber: string;
  accountName: string;
  paystackRecipientCode?: string;
}

export interface IRiderProfile extends Document {
  user: mongoose.Types.ObjectId;
  vehicleType: "motorcycle" | "tricycle" | "van";
  vehiclePlate: string;
  isAvailable: boolean;
  isVerified: boolean;
  currentLocation?: { lat: number; lng: number };
  rating: number;
  totalDeliveries: number;
  bankAccount?: IBankAccount;
  createdAt: Date;
  updatedAt: Date;
}

const RiderProfileSchema: Schema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: "User", required: true, unique: true },
    vehicleType: {
      type: String,
      enum: ["motorcycle", "tricycle", "van"],
      required: true,
    },
    vehiclePlate: { type: String, required: true },
    isAvailable: { type: Boolean, default: false },
    isVerified: { type: Boolean, default: false },
    currentLocation: {
      lat: { type: Number },
      lng: { type: Number },
    },
    rating: { type: Number, default: 0 },
    totalDeliveries: { type: Number, default: 0 },
    bankAccount: {
      bankName: { type: String },
      accountNumber: { type: String },
      accountName: { type: String },
      paystackRecipientCode: { type: String },
    },
  },
  { timestamps: true }
);

RiderProfileSchema.index({ "currentLocation.lat": 1, "currentLocation.lng": 1 });
RiderProfileSchema.index({ isAvailable: 1 });

export default mongoose.model<IRiderProfile>("RiderProfile", RiderProfileSchema);
