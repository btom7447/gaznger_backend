import mongoose, { Schema, Document } from "mongoose";

export interface IBankAccount {
  bankName: string;
  accountNumber: string;
  accountName: string;
  paystackRecipientCode?: string;
}

export interface IRiderProfile extends Document {
  user: mongoose.Types.ObjectId;
  vehicleType: "motorcycle" | "car" | "truck";
  vehicleBrand?: string;
  vehiclePlate: string;
  vehicleColor?: string;
  vehicleYear?: number;
  isAvailable: boolean;
  isVerified: boolean;
  verificationStatus: "pending" | "verified" | "rejected";
  verificationNote?: string;
  // KYC documents
  nationalIdUrl?: string;
  driversLicenseUrl?: string;
  vehiclePapersUrl?: string;
  vehicleImageUrl?: string;
  plateImageUrl?: string;
  currentLocation?: { lat: number; lng: number };
  rating: number;
  totalDeliveries: number;
  totalDropped: number;
  bankAccount?: IBankAccount;
  createdAt: Date;
  updatedAt: Date;
}

const RiderProfileSchema: Schema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: "User", required: true, unique: true },
    vehicleType: {
      type: String,
      enum: ["motorcycle", "car", "truck"],
      required: true,
    },
    vehicleBrand: { type: String },
    vehiclePlate: { type: String, required: true },
    vehicleColor: { type: String },
    vehicleYear: { type: Number },
    isAvailable: { type: Boolean, default: false },
    isVerified: { type: Boolean, default: false },
    verificationStatus: {
      type: String,
      enum: ["pending", "verified", "rejected"],
      default: "pending",
    },
    verificationNote: { type: String },
    // KYC documents (Cloudinary URLs)
    nationalIdUrl: { type: String },
    driversLicenseUrl: { type: String },
    vehiclePapersUrl: { type: String },
    vehicleImageUrl: { type: String },
    plateImageUrl: { type: String },
    currentLocation: {
      lat: { type: Number },
      lng: { type: Number },
    },
    rating: { type: Number, default: 0 },
    totalDeliveries: { type: Number, default: 0 },
    totalDropped: { type: Number, default: 0 },
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
