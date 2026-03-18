import mongoose, { Schema, Document } from "mongoose";

export interface IUser extends Document {
  email: string;
  phone?: string;
  passwordHash: string;
  displayName: string;
  profileImage: string;
  gender: "male" | "female";
  role: "customer" | "vendor" | "rider" | "admin";
  isOnboarded: boolean;
  defaultAddress?: mongoose.Types.ObjectId | null;
  addressBook: mongoose.Types.ObjectId[];
  points: number;
  deviceTokens: string[];
  createdAt: Date;
  updatedAt: Date;

  otpCode?: string;
  otpExpiresAt?: Date;
  isVerified?: boolean;
}

const defaultMaleImage = "https://avatar.iran.liara.run/public/19";
const defaultFemaleImage = "https://avatar.iran.liara.run/public/57";

const UserSchema: Schema<IUser> = new Schema(
  {
    email: { type: String, required: true, unique: true },
    phone: { type: String, default: "" },
    passwordHash: { type: String, required: true },
    displayName: { type: String, default: "Guest" },
    gender: { type: String, enum: ["male", "female"], default: "male" },
    role: { type: String, enum: ["customer", "vendor", "rider", "admin"], default: "customer" },
    isOnboarded: { type: Boolean, default: false },
    profileImage: {
      type: String,
      default: function (this: IUser) {
        return this.gender === "female" ? defaultFemaleImage : defaultMaleImage;
      },
    },
    addressBook: [{ type: Schema.Types.ObjectId, ref: "Address" }],
    defaultAddress: { type: Schema.Types.ObjectId, ref: "Address" },
    points: { type: Number, default: 0 },
    deviceTokens: { type: [String], default: [] },

    otpCode: { type: String },
    otpExpiresAt: { type: Date },
    isVerified: { type: Boolean, default: false },
  },
  { timestamps: true }
);

UserSchema.index({ email: 1 });

export default mongoose.model<IUser>("User", UserSchema);
