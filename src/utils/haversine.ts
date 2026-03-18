const EARTH_RADIUS_KM = 6371;

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

/**
 * Calculate the great-circle distance between two coordinates (Haversine formula).
 * @returns Distance in kilometres.
 */
export function haversineDistance(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number }
): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const sinDLat = Math.sin(dLat / 2);
  const sinDLng = Math.sin(dLng / 2);

  const h =
    sinDLat * sinDLat +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * sinDLng * sinDLng;

  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h));
}

/**
 * Calculate delivery fee based on distance.
 * Rates are configurable via env vars.
 */
export function calcDeliveryFee(distanceKm: number): number {
  const baseFee = Number(process.env.DELIVERY_BASE_FEE) || 500;
  const perKm = Number(process.env.DELIVERY_PER_KM) || 100;
  return Math.round(baseFee + distanceKm * perKm);
}
