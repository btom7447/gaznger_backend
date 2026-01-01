import mongoose, { Schema, Document } from "mongoose";

export interface IUser extends Document {
  email: string;
  phone?: string;
  passwordHash: string;
  displayName: string;
  profileImage: string;
  gender: "male" | "female";
  addressBook: mongoose.Types.ObjectId[];
  points: number;
  deviceTokens: string[];
  createdAt: Date;
  updatedAt: Date;
}

// Default profile images
const defaultMaleImage = "https://avatar.iran.liara.run/public/19";
const defaultFemaleImage = "https://avatar.iran.liara.run/public/57";

const UserSchema: Schema<IUser> = new Schema(
  {
    email: { type: String, required: true, unique: true },
    phone: { type: String, default: "" },
    passwordHash: { type: String, required: true },
    displayName: { type: String, default: "Guest" },
    gender: { type: String, enum: ["male", "female"], default: "male" },
    profileImage: {
      type: String,
      default: function (this: IUser) {
        return this.gender === "female" ? defaultFemaleImage : defaultMaleImage;
      },
    },
    addressBook: [{ type: Schema.Types.ObjectId, ref: "Address" }],
    points: { type: Number, default: 0 },
    deviceTokens: { type: [String], default: [] },
  },
  { timestamps: true }
);

export default mongoose.model<IUser>("User", UserSchema);
