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

  vendorBankAccount?: { bankName: string; accountNumber: string; accountName: string };
  vendorVerification?: {
    status: "none" | "pending" | "verified" | "rejected";
    documents: { label: string; url: string }[];
    submittedAt?: Date;
    reviewedAt?: Date;
    note?: string;
  };
  partnerBadge?: { plan: string; active: boolean; subscribedAt?: Date };

  /**
   * Paystack saved-card metadata. Populated automatically on first
   * successful charge via webhook (data.authorization). Used for
   * "Charge saved card" path so returning customers skip the webview.
   * Only safe-to-display fields are kept here — no PAN, no CVV.
   */
  lastPaystackAuth?: {
    authorizationCode: string;
    last4: string;
    brand?: string;
    bank?: string;
    expMonth?: string;
    expYear?: string;
    cardType?: string;
    signature?: string;
  };

  /**
   * Lifecycle gate set by admin. `active` is the only state that allows
   * vendors/riders to receive orders/jobs and customers to charge.
   * `pending` = newly registered, awaiting verification.
   * `suspended` = admin-paused (rules violation, dispute).
   */
  accountStatus?: "pending" | "active" | "suspended";

  /**
   * Withdrawal hold. When `active=true`, /withdraw is gated. Used for
   * policy violations, owed money, or while a dispute is open.
   */
  withdrawalHold?: {
    active: boolean;
    reason?: string;
    setBy?: mongoose.Types.ObjectId;
    setAt?: Date;
  };

  /**
   * LPG-Swap saved cylinder profile. Captured on the first successful
   * swap when the customer accepts the "save cylinder" prompt; surfaced
   * back on the Cylinder + Photo screens to skip re-entry on subsequent
   * orders.
   */
  savedCylinder?: {
    brand?: string;
    valve?: string;
    age?: string;
    test?: string;
    photos?: string[];
    savedAt?: Date;
  };

  /**
   * Customer-side preferences. All optional — server treats `undefined`
   * as the default policy:
   *   - autoRedeemPoints: false. When true, /api/orders POST + payment
   *     flow auto-applies the max-redeemable points unless the client
   *     overrides per-order.
   *   - priceAlertsEnabled: false. When true, push notifications about
   *     nearby market price drops (informational, never customer-specific
   *     order pricing — pricing rule honoured server-side).
   *   - pushEnabled: true. Master push toggle; when false, the server
   *     skips push delivery (in-app inbox still receives).
   *   - notificationsFilter: persisted "last selected" filter for the
   *     Notifications inbox. Client mirrors locally; server-side is the
   *     source of truth across devices.
   */
  preferences?: {
    autoRedeemPoints?: boolean;
    priceAlertsEnabled?: boolean;
    pushEnabled?: boolean;
    notificationsFilter?: string;
  };
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

    vendorBankAccount: {
      bankName: { type: String, default: "" },
      accountNumber: { type: String, default: "" },
      accountName: { type: String, default: "" },
    },
    vendorVerification: {
      status: { type: String, enum: ["none", "pending", "verified", "rejected"], default: "none" },
      documents: [{ label: { type: String }, url: { type: String } }],
      submittedAt: { type: Date },
      reviewedAt: { type: Date },
      note: { type: String },
    },
    partnerBadge: {
      plan: { type: String, default: "" },
      active: { type: Boolean, default: false },
      subscribedAt: { type: Date },
    },

    lastPaystackAuth: {
      authorizationCode: { type: String },
      last4: { type: String },
      brand: { type: String },
      bank: { type: String },
      expMonth: { type: String },
      expYear: { type: String },
      cardType: { type: String },
      signature: { type: String },
    },

    accountStatus: {
      type: String,
      enum: ["pending", "active", "suspended"],
      default: "active",
    },

    withdrawalHold: {
      active: { type: Boolean, default: false },
      reason: { type: String },
      setBy: { type: Schema.Types.ObjectId, ref: "User" },
      setAt: { type: Date },
    },

    savedCylinder: {
      brand: { type: String },
      valve: { type: String },
      age: { type: String },
      test: { type: String },
      photos: [{ type: String }],
      savedAt: { type: Date },
    },

    preferences: {
      autoRedeemPoints: { type: Boolean, default: false },
      priceAlertsEnabled: { type: Boolean, default: false },
      pushEnabled: { type: Boolean, default: true },
      notificationsFilter: { type: String },
    },
  },
  { timestamps: true }
);

export default mongoose.model<IUser>("User", UserSchema);
