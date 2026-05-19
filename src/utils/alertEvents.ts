/**
 * Helpers for non-order alert socket events the audit named as
 * "missing entirely" (WS_VS_API §missing):
 *   - stock:alert    (vendor — fuel below threshold or marked
 *                     unavailable)
 *   - payment:failed (customer — async settlement failure)
 *
 * Callers fire these from the write sites that already detect the
 * condition. The handlers are intentionally thin — they just
 * standardise the payload + namespace.
 */
import { emitToUser } from "../socket";

export type StockAlertKind = "low" | "out" | "unavailable";

export function emitStockAlert(
  vendorId: string,
  payload: {
    stationId: string;
    stationName?: string;
    fuel?: string;
    kind: StockAlertKind;
    level?: number;
  },
): void {
  emitToUser(vendorId, "stock:alert", payload);
}

export function emitPaymentFailed(
  userId: string,
  payload: {
    orderId?: string;
    reference?: string;
    reason: string;
    amount?: number;
  },
): void {
  emitToUser(userId, "payment:failed", payload);
}

export function emitRatingSubmitted(
  vendorId: string,
  payload: {
    orderId: string;
    stationId?: string;
    stars: number;
    newAverage?: number;
    totalRatings?: number;
  },
): void {
  emitToUser(vendorId, "rating:submitted", payload);
}
