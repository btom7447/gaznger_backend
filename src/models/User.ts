import mongoose, { Schema, Document } from "mongoose";

export interface IUser extends Document {
  /**
   * E.164-normalised phone (e.g. "+2348012345678"). Unique. Primary
   * identity for the v4 auth slice. Always set on new accounts; legacy
   * email-only accounts may be missing it (cleared by the migration
   * note in seed.ts).
   */
  phone: string;
  email?: string;
  /** Legacy password hash. Optional after the v4 cutover; not set on phone-signup users. */
  passwordHash?: string;
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

  /**
   * Whether the account holder has completed the SMS-OTP step on the
   * current phone number. Set on /auth/signup and /auth/forgot-pin/reset.
   */
  phoneVerified?: boolean;

  /**
   * Devices the user has authenticated from. The `X-Device-Id` header
   * from the mobile maps to entries here. Capped at 5 — see
   * docs/handoff/_server-asks/auth-device-binding.md.
   */
  knownDevices?: Array<{
    deviceId: string;
    label?: string;
    firstSeenAt: Date;
    lastSeenAt: Date;
  }>;

  /**
   * Rider/vendor verification gate. Customers don't carry this field.
   * Pushed to mobile via /auth/me + the `verification:status` socket
   * event when admin transitions it.
   */
  verificationStatus?: "pending" | "approved" | "rejected";
  verificationReason?: string;
  verificationReviewedAt?: Date;
  verificationReviewedBy?: mongoose.Types.ObjectId;

  /**
   * Verification documents — per-kind URL refs uploaded via the existing
   * /api/upload Cloudinary endpoint. Each entry is a stored Cloudinary
   * URL plus the moment it was last received. Admin tooling reads from
   * here when reviewing a verification.
   */
  verificationDocs?: Array<{
    kind: string;
    url: string;
    uploadedAt: Date;
  }>;

  /** Legacy email-OTP fields. Will be removed after the v4 cutover; kept here so old data doesn't error on read. */
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
  accountStatus?: "pending" | "active" | "suspended" | "deleted";
  /** Set when user soft-deleted via /auth/me/delete. Hard-delete cron
   *  picks up rows where deletedAt < now - 30d. */
  deletedAt?: Date;

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
    /**
     * Sub-toggles for the "All notifications" master switch in Settings.
     * `pushEnabled` remains the master gate — these only matter when
     * push is on. `orderUpdates` defaults true (most useful channel),
     * `promotions` defaults false (we err on the side of less spam).
     */
    orderUpdates?: boolean;
    promotions?: boolean;
    notificationsFilter?: string;
  };

  /**
   * Optional 4-digit PIN, hashed via bcrypt. When set, the client
   * surfaces a "Verify PIN" gate before sensitive actions (delete
   * account, change phone, withdraw). NEVER returned by `/auth/me`
   * — only its presence (boolean) is exposed.
   */
  pinHash?: string;
  /**
   * Brute-force protection for PIN-gated routes (`/auth/login`,
   * `/auth/pin/verify`). Counts wrong-PIN attempts within a rolling
   * window; once `count >= 5` AND `firstFailedAt` is within the last
   * 15 min, `lockedUntil` is set to now+15min and PIN routes return
   * 423 with no signal until the lock expires. Successful PIN check
   * resets the subdoc.
   *
   * SECURITY (audit A.4): without this, a 4-digit PIN is brute-
   * forceable through the IP-only `authLimiter` — ~120 guesses/hour
   * per IP, trivially bypassed by IP rotation, against a 10,000-key
   * keyspace.
   */
  pinFailures?: {
    count: number;
    firstFailedAt?: Date;
    lockedUntil?: Date;
  };
}

const defaultMaleImage = "https://avatar.iran.liara.run/public/19";
const defaultFemaleImage = "https://avatar.iran.liara.run/public/57";

const UserSchema: Schema<IUser> = new Schema(
  {
    phone: { type: String, required: true, unique: true, index: true },
    email: { type: String, sparse: true, index: true },
    passwordHash: { type: String },
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

    phoneVerified: { type: Boolean, default: false },

    knownDevices: [
      {
        deviceId: { type: String, required: true },
        label: { type: String },
        firstSeenAt: { type: Date, default: Date.now },
        lastSeenAt: { type: Date, default: Date.now },
      },
    ],

    verificationStatus: {
      type: String,
      enum: ["pending", "approved", "rejected"],
    },
    verificationReason: { type: String },
    verificationReviewedAt: { type: Date },
    verificationReviewedBy: { type: Schema.Types.ObjectId, ref: "User" },
    verificationDocs: [
      {
        kind: { type: String, required: true },
        url: { type: String, required: true },
        uploadedAt: { type: Date, default: Date.now },
      },
    ],

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
      enum: ["pending", "active", "suspended", "deleted"],
      default: "active",
    },
    deletedAt: { type: Date },

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
      orderUpdates: { type: Boolean, default: true },
      promotions: { type: Boolean, default: false },
      notificationsFilter: { type: String },
    },

    pinHash: { type: String },
    pinFailures: {
      count: { type: Number, default: 0 },
      firstFailedAt: { type: Date },
      lockedUntil: { type: Date },
    },
  },
  { timestamps: true }
);

export default mongoose.model<IUser>("User", UserSchema);
