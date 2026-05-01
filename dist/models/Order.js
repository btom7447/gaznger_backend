"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const mongoose_1 = __importStar(require("mongoose"));
const OrderSchema = new mongoose_1.Schema({
    user: { type: mongoose_1.Schema.Types.ObjectId, ref: "User", required: true },
    fuel: { type: mongoose_1.Schema.Types.ObjectId, ref: "FuelType", required: true },
    station: { type: mongoose_1.Schema.Types.ObjectId, ref: "GasStation", required: true },
    quantity: { type: Number, required: true },
    unit: { type: String, required: true },
    fuelCost: { type: Number, required: true },
    deliveryFee: { type: Number, required: true, default: 0 },
    totalPrice: { type: Number, required: true },
    /**
     * Order status enum. Spans both the legacy flow
     * (`pending → confirmed → assigned → in-transit →
     * awaiting_confirmation → delivered`) and the v3 granular flow
     * that the upgraded rider app drives (`assigned → at_plant →
     * refilling → returning → arrived → dispensing →
     * awaiting_confirmation → delivered`). Both pipelines coexist
     * so we can roll out the rider-app upgrade without forcing a
     * cutover; old rider clients keep using the legacy values
     * while new ones drive the granular ones, and the customer app
     * already handles both transparently via getTrackPhase.
     *
     * pending_payment + the granular cancellation reasons aren't
     * stored here — they live on Delivery / paymentStatus / a
     * cancellation note — so the enum stays focused on the
     * delivery lifecycle alone.
     */
    status: {
        type: String,
        enum: [
            // Legacy values (still emitted by the legacy rider app).
            "pending",
            "confirmed",
            "assigned",
            "in-transit",
            "awaiting_confirmation",
            "delivered",
            "cancelled",
            // v3 granular values (emitted by the upgraded rider app).
            "at_plant",
            "refilling",
            "returning",
            "arrived",
            "dispensing",
        ],
        default: "pending",
    },
    deliveryAddress: {
        type: mongoose_1.Schema.Types.ObjectId,
        ref: "Address",
        required: true,
    },
    paymentStatus: {
        type: String,
        enum: ["unpaid", "paid", "refunded"],
        default: "unpaid",
    },
    paymentRef: { type: String },
    riderId: { type: mongoose_1.Schema.Types.ObjectId, ref: "User" },
    riderAssignedAt: { type: Date },
    dispatchAttempt: { type: Number, default: 0 },
    dispatchExpiresAt: { type: Date },
    note: { type: String, maxlength: 500 },
    returnSwapAt: { type: Date, default: null },
    deliveredAt: { type: Date },
    customerHereAt: { type: Date },
    totalCharged: { type: Number },
    weighIn: {
        emptyKg: { type: Number },
        fullKg: { type: Number },
        netKg: { type: Number },
        weighedAt: { type: Date },
    },
    pointsEarned: { type: Number },
    rating: {
        stars: { type: Number, min: 1, max: 5 },
        tags: [{ type: String }],
        tip: { type: Number, default: 0 },
        note: { type: String, maxlength: 500 },
        ratedAt: { type: Date },
    },
    // Gas-specific
    cylinderType: { type: String },
    deliveryType: { type: String, enum: ["cylinder_swap", "home_refill"] },
    cylinderImages: [{ type: String }],
    cylinderDetails: {
        brand: { type: String },
        valve: { type: String },
        age: { type: String },
        test: { type: String },
    },
}, { timestamps: true });
OrderSchema.index({ user: 1, status: 1 });
OrderSchema.index({ createdAt: -1 });
OrderSchema.index({ paymentRef: 1 });
exports.default = mongoose_1.default.model("Order", OrderSchema);
//# sourceMappingURL=Order.js.map