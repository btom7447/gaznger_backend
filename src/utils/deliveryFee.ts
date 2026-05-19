/**
 * Single source of truth for the delivery-fee calculation. Used by:
 *   - server/src/routes/orders.ts (POST /api/orders) to charge the
 *     customer the right amount at order-create time
 *   - server/src/routes/orders.ts (GET /api/orders/:id/quote — Phase 2)
 *     so the mobile client can fetch the SAME number for its preview
 *
 * The mobile client previously mirrored a simpler version of this
 * math and missed the LPG-swap 2× multiplier — BUSINESS_RULES P0-2.
 * From Phase 2 onward, the client fetches the quote via the server
 * endpoint instead of mirroring the formula.
 *
 * Formula (env-driven):
 *   base = DELIVERY_BASE_FEE   (default 500)
 *   perKm = DELIVERY_PER_KM    (default 100)
 *   raw = base + distanceKm * perKm
 *   if (LPG swap)  → raw * 2     // 2-trip job: deliver empty + return full
 *   result = round(raw)
 *
 * Returns a kobo-style integer (₦, not kobo — codebase convention).
 */
import { calcDeliveryFee, haversineDistance } from "./haversine";

export interface DeliveryFeeInput {
  /** Station coords. */
  from: { lat: number; lng: number };
  /** Customer delivery address coords. */
  to: { lat: number; lng: number };
  /** "Gas" for LPG, "Petrol"/"Diesel"/"Kerosene" otherwise. */
  fuelName: string;
  /** Order delivery type — "cylinder_swap" doubles the fee for LPG. */
  deliveryType?: string;
}

export interface DeliveryFeeBreakdown {
  base: number;
  perKm: number;
  distanceKm: number;
  rawFee: number;
  multiplier: number;
  reason: string | null;
  finalFee: number;
}

const FALLBACK_FEE = Number(process.env.DELIVERY_BASE_FEE) || 500;

export function computeDeliveryFee(input: DeliveryFeeInput): DeliveryFeeBreakdown {
  const base = Number(process.env.DELIVERY_BASE_FEE) || 500;
  const perKm = Number(process.env.DELIVERY_PER_KM) || 100;

  const fromHasCoords = input.from.lat !== 0 && input.from.lng !== 0;
  const toHasCoords = input.to.lat !== 0 && input.to.lng !== 0;

  const distanceKm =
    fromHasCoords && toHasCoords
      ? haversineDistance(input.from, input.to)
      : 0;

  const rawFee =
    fromHasCoords && toHasCoords ? calcDeliveryFee(distanceKm) : FALLBACK_FEE;

  // BUSINESS_RULES P0-2 — LPG swap = 2-trip job (deliver full + pick
  // up empty). Server doubles the fee at order-create time so escrow
  // holds the right total upfront. Client must use this helper (via
  // /api/orders/quote) to preview the same number.
  const isLpgSwap =
    input.fuelName === "Gas" && input.deliveryType === "cylinder_swap";
  const multiplier = isLpgSwap ? 2 : 1;
  const reason = isLpgSwap ? "LPG swap (2-trip)" : null;

  return {
    base,
    perKm,
    distanceKm,
    rawFee,
    multiplier,
    reason,
    finalFee: Math.round(rawFee * multiplier),
  };
}
