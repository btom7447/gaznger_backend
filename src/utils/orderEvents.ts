/**
 * Order socket-event helpers.
 *
 * Closes:
 *   - EDGE P1-6 — monotonic `version` per Order so mobile clients
 *     can drop stale events in the cancel-vs-accept race.
 *   - WS_VS_API P0 #1 — vendor `order:update` carries the full
 *     OrderDetail shape so the mobile client doesn't have to GET
 *     /api/vendor/orders/:id on every event.
 *   - SYNC P0 / WS_VS_API #4 — granular `order:rider-assigned` and
 *     `order:confirmed` / `order:rejected` events emitted alongside
 *     the generic `order:update` so the vendor app can patch its
 *     local cache without a full refetch.
 *
 * Every status-mutation site should call one of these helpers
 * instead of `emitToUser(..., "order:update", { status })` directly,
 * so the version bump + full payload + dual-emit stays consistent.
 *
 * Mobile order:update listener (Phase 2) expects:
 *   {
 *     orderId: string,
 *     status: string,
 *     version: number,                       // monotonic
 *     // optional rich fields (vendor namespace):
 *     fullOrder?: OrderDetailShape,
 *     ...event-specific fields
 *   }
 */
import { Types } from "mongoose";
import Order, { IOrder } from "../models/Order";
import { emitToUser } from "../socket";

/**
 * Bump `version` AND save the order. Callers that already have the
 * doc in memory should use this in place of a bare `order.save()`
 * when the change is a status (or other rider-visible) transition.
 *
 * Returns the saved doc so callers can chain.
 */
export async function bumpAndSaveOrder(order: IOrder): Promise<IOrder> {
  order.version = (order.version ?? 0) + 1;
  await order.save();
  return order;
}

interface OrderUpdatePayload {
  orderId: string;
  status: string;
  version: number;
  riderId?: string;
  riderName?: string;
  riderPlate?: string;
  eta?: number;
  deliveredAt?: string;
  totalCharged?: number;
  pointsEarned?: number;
  weighIn?: { emptyKg: number; fullKg: number; netKg: number };
  /** Vendor-namespace emits attach the lean OrderDetail here. */
  fullOrder?: Record<string, unknown>;
}

/**
 * Emit `order:update` to BOTH the customer AND the vendor (if the
 * station has a vendor). Vendor payload includes `fullOrder` so the
 * vendor app's local cache patches without a follow-up GET.
 *
 * Caller is responsible for bumping `order.version` before invoking
 * — typically via `bumpAndSaveOrder()`.
 */
export function emitOrderUpdate(
  order: IOrder,
  vendorId: Types.ObjectId | string | null | undefined,
  extras: Partial<Omit<OrderUpdatePayload, "orderId" | "status" | "version">> = {},
): void {
  const base: OrderUpdatePayload = {
    orderId: String(order._id),
    status: order.status,
    version: order.version ?? 0,
    ...extras,
  };

  // Customer hears the lean payload (status + version + any rider /
  // delivery extras). The customer's track screen doesn't need the
  // full OrderDetail — it has its own GET on first attach.
  emitToUser(order.user.toString(), "order:update", base);

  // Vendor hears the same envelope PLUS a `fullOrder` snapshot.
  if (vendorId) {
    emitToUser(String(vendorId), "order:update", {
      ...base,
      fullOrder: leanOrderDetail(order),
    });
  }
}

/**
 * Granular `order:rider-assigned` emit alongside the generic
 * `order:update`. Vendor app subscribes to both: the generic for
 * status-bar refresh, the granular for the rider-card add. Mobile
 * also catches this push so the vendor's AssignRiderSheet doesn't
 * need to refetch its roster.
 */
export function emitRiderAssigned(
  order: IOrder,
  vendorId: Types.ObjectId | string | null | undefined,
  rider: {
    riderId: string;
    riderName?: string;
    riderPlate?: string;
    riderPhone?: string;
  },
): void {
  const payload = {
    orderId: String(order._id),
    riderId: rider.riderId,
    riderName: rider.riderName ?? null,
    riderPlate: rider.riderPlate ?? null,
    riderPhone: rider.riderPhone ?? null,
    version: order.version ?? 0,
  };
  // Vendor: granular event.
  if (vendorId) {
    emitToUser(String(vendorId), "order:rider-assigned", payload);
  }
  // Customer: same event so they can render the rider card without
  // waiting for the next generic order:update.
  emitToUser(order.user.toString(), "order:rider-assigned", payload);
}

/** Explicit confirm semantic event (SYNC P1 / WS_VS_API #4). */
export function emitOrderConfirmed(
  order: IOrder,
  vendorId: Types.ObjectId | string | null | undefined,
): void {
  const payload = {
    orderId: String(order._id),
    version: order.version ?? 0,
  };
  emitToUser(order.user.toString(), "order:confirmed", payload);
  if (vendorId) {
    emitToUser(String(vendorId), "order:confirmed", payload);
  }
}

/** Explicit reject semantic event (SYNC P1 / decision D4). */
export function emitOrderRejected(
  order: IOrder,
  vendorId: Types.ObjectId | string | null | undefined,
  reason: string,
  notes?: string,
): void {
  const payload = {
    orderId: String(order._id),
    reason,
    notes: notes ?? null,
    version: order.version ?? 0,
  };
  emitToUser(order.user.toString(), "order:rejected", payload);
  if (vendorId) {
    emitToUser(String(vendorId), "order:rejected", payload);
  }
}

/**
 * Lean snapshot used in vendor `fullOrder` payload. Strips heavy
 * fields (cylinderImages, weighIn) and keeps only what the vendor
 * order detail screen renders.
 */
function leanOrderDetail(order: IOrder): Record<string, unknown> {
  return {
    _id: String(order._id),
    status: order.status,
    version: order.version ?? 0,
    quantity: order.quantity,
    unit: order.unit,
    fuelCost: order.fuelCost,
    deliveryFee: order.deliveryFee,
    serviceFee: order.serviceFee,
    totalPrice: order.totalPrice,
    totalCharged: order.totalCharged ?? null,
    paymentStatus: order.paymentStatus,
    paymentRef: order.paymentRef ?? null,
    riderId: order.riderId ? String(order.riderId) : null,
    riderAssignedAt: order.riderAssignedAt ?? null,
    deliveredAt: order.deliveredAt ?? null,
    customerHereAt: order.customerHereAt ?? null,
    cancellationReason: order.cancellationReason ?? null,
    note: order.note ?? null,
    deliveryType: order.deliveryType ?? null,
    cylinderType: order.cylinderType ?? null,
  };
}
