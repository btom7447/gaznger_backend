/**
 * Route polyline computation for the rider→station / rider→destination
 * legs. Shared between:
 *   - GET /api/orders/:orderId/route (customer-initiated synchronous fetch)
 *   - the rider:location socket handler (push-based broadcast on each
 *     rider GPS ping, throttled to keep Directions API spend in check)
 *
 * Throttling layers (cheapest → most expensive):
 *   1. **Per-order min interval**: don't recompute more than once every
 *      MIN_RECOMPUTE_INTERVAL_MS, regardless of distance moved.
 *   2. **Distance gating**: skip recompute if the rider hasn't moved
 *      ≥ MIN_DISTANCE_M since the last computed origin AND the cached
 *      result is still warm.
 *   3. **30s in-memory cache** keyed on (orderId, target, gridded coord).
 *      Even if 1+2 say "go", the cache covers identical-position calls
 *      from multiple sources (route GET + socket push in the same window).
 *
 * Phase boundaries (target=station → destination) bypass the throttle
 * via `force: true` so the customer never sees a stale leg after pickup.
 */

import Order from "../models/Order";

/**
 * One leg-step from Google Directions, normalised for the rider's
 * navigation banner. Only the fields the client actually renders are
 * exposed — html_instructions is stripped to plain text upstream.
 */
export interface RouteStep {
  /** Plain-text maneuver text — "Turn right onto Aba Road". */
  instruction: string;
  /** Length of THIS step in meters. */
  distanceM: number;
  /** Estimated time for THIS step in seconds. */
  durationS: number;
  /**
   * Maneuver code from Google ("turn-left", "turn-right", "merge",
   * "roundabout-left", "ramp-right", …). Optional — many
   * straight-line steps don't include one. The client maps this
   * to an icon glyph for the banner.
   */
  maneuver?: string;
  /** Step start point. Used by the client to find the current step. */
  startLat: number;
  startLng: number;
  /** Step end point. */
  endLat: number;
  endLng: number;
}

export interface RouteResult {
  polyline: [number, number][];
  distanceMeters: number;
  durationSeconds: number;
  /**
   * Per-step turn-by-turn instructions. Used by the rider's nav
   * banner. Empty array on cache hits where we didn't decode steps,
   * and on straight-line fallbacks.
   */
  steps: RouteStep[];
  /** True when this came from the in-memory cache. */
  cached: boolean;
  /** True when Directions API failed and we returned a straight-line. */
  fellBackToStraight: boolean;
}

export type RouteTarget = "station" | "destination";

/**
 * Map a Delivery status string to the leg the rider is currently
 * driving. Returns null when there's no leg to draw (pre-pickup with
 * no rider GPS yet, or terminal states).
 *
 * Mirrors the customer-side phase derivation in [TrackPhase] but
 * outputs the route-target enum directly so callers don't have to
 * translate twice.
 */
export function routeTargetForStatus(status: string): RouteTarget | null {
  switch (status) {
    // Outbound leg — rider heading to the station.
    case "accepted":
    case "at_plant":
    case "refilling":
      return "station";
    // Inbound leg — rider heading to the customer.
    case "picked_up":
    case "returning":
    case "in-transit":
    case "in_transit":
    case "arrived":
    case "dispensing":
    case "awaiting_confirmation":
      return "destination";
    default:
      return null;
  }
}

const ROUTE_CACHE_TTL_MS = 30_000;
const MIN_RECOMPUTE_INTERVAL_MS = 5_000;
const MIN_DISTANCE_M = 80;

interface CacheEntry {
  polyline: [number, number][];
  distanceMeters: number;
  durationSeconds: number;
  steps: RouteStep[];
  expiresAt: number;
}

/**
 * Strip a subset of HTML tags from Google's `html_instructions` to
 * plain text. Google embeds <b>, <div>, and <wbr/> in maneuver text;
 * naive `.replace(/<[^>]+>/g, "")` is enough for the maneuver shapes
 * Directions uses (no nested tags, no entities other than &amp;).
 */
function stripHtml(s: string): string {
  return s
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const routeCache = new Map<string, CacheEntry>();

/**
 * Per-order recompute bookkeeping. Tracks the last origin we routed
 * from + when we did so, so the rider:location handler can decide
 * whether to call out to Directions or skip.
 */
interface RecomputeState {
  lastOriginLat: number;
  lastOriginLng: number;
  lastTarget: RouteTarget;
  lastComputedAt: number;
}
const recomputeState = new Map<string, RecomputeState>();

/** Haversine distance in meters between two coords. */
function haversineMeters(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number }
): number {
  const R = 6_371_000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * R * Math.asin(Math.sqrt(x));
}

/**
 * Decide whether the next rider:location ping warrants a fresh route
 * compute. Returns true when:
 *   - no prior compute for this order, OR
 *   - target has changed since last compute (phase boundary), OR
 *   - rider has moved ≥ MIN_DISTANCE_M since last origin AND
 *     ≥ MIN_RECOMPUTE_INTERVAL_MS has passed.
 *
 * Caller can pass `force: true` to bypass — used on phase transitions
 * fired by status-change handlers, where we want an immediate refresh.
 */
export function shouldRecomputeRoute(
  orderId: string,
  riderLat: number,
  riderLng: number,
  target: RouteTarget,
  force = false
): boolean {
  if (force) return true;
  const state = recomputeState.get(orderId);
  if (!state) return true;
  if (state.lastTarget !== target) return true;
  const sinceMs = Date.now() - state.lastComputedAt;
  if (sinceMs < MIN_RECOMPUTE_INTERVAL_MS) return false;
  const moved = haversineMeters(
    { lat: state.lastOriginLat, lng: state.lastOriginLng },
    { lat: riderLat, lng: riderLng }
  );
  return moved >= MIN_DISTANCE_M;
}

/** Decode Google's encoded polyline string into [lat, lng] tuples. */
export function decodePolyline(encoded: string): [number, number][] {
  const points: [number, number][] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;
  while (index < encoded.length) {
    let result = 0;
    let shift = 0;
    let b: number;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    const dlat = (result & 1) !== 0 ? ~(result >> 1) : result >> 1;
    lat += dlat;
    result = 0;
    shift = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    const dlng = (result & 1) !== 0 ? ~(result >> 1) : result >> 1;
    lng += dlng;
    points.push([lat / 1e5, lng / 1e5]);
  }
  return points;
}

/**
 * Compute (or cache-hit) the rider→target polyline for an order.
 *
 * Returns null when the target has no coords (shouldn't happen in
 * practice — orders are gated on station + delivery address) or when
 * the order doesn't exist. Returns a straight-line fallback (with
 * `fellBackToStraight: true`) when the API key is missing or Google's
 * Directions API fails. Loud server-side logging on every fallback so
 * misconfiguration is visible in production logs.
 */
export async function computeRoute(
  orderId: string,
  riderLat: number,
  riderLng: number,
  target: RouteTarget
): Promise<RouteResult | null> {
  const order = await Order.findById(orderId)
    .populate({ path: "deliveryAddress", select: "latitude longitude" })
    .populate({ path: "station", select: "location" })
    .lean();
  if (!order) return null;

  let destLat: number | undefined;
  let destLng: number | undefined;
  if (target === "station") {
    const station = (order as any).station as
      | { location?: { lat?: number; lng?: number } }
      | undefined;
    destLat = station?.location?.lat;
    destLng = station?.location?.lng;
  } else {
    const dest = (order as any).deliveryAddress as
      | { latitude?: number; longitude?: number }
      | undefined;
    destLat = dest?.latitude;
    destLng = dest?.longitude;
  }
  if (destLat == null || destLng == null) return null;

  // Cache key: gridded to ~110 m so two pings within the same tile
  // share a single Directions call. Tighter than the 100 m distance
  // gate on purpose — different sources (route GET + socket push)
  // arriving microseconds apart should hit the same cache entry.
  const cacheKey = `${orderId}:${target}:${riderLat.toFixed(3)},${riderLng.toFixed(
    3
  )}`;
  const cached = routeCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return {
      polyline: cached.polyline,
      distanceMeters: cached.distanceMeters,
      durationSeconds: cached.durationSeconds,
      steps: cached.steps,
      cached: true,
      fellBackToStraight: false,
    };
  }

  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) {
    console.warn(
      "[routePolyline] GOOGLE_MAPS_API_KEY not set — returning straight-line fallback"
    );
    return {
      polyline: [
        [riderLat, riderLng],
        [destLat, destLng],
      ],
      distanceMeters: 0,
      durationSeconds: 0,
      steps: [],
      cached: false,
      fellBackToStraight: true,
    };
  }

  const params = new URLSearchParams({
    origin: `${riderLat},${riderLng}`,
    destination: `${destLat},${destLng}`,
    mode: "driving",
    key: apiKey,
  });
  let directionsData: {
    status: string;
    error_message?: string;
    routes?: {
      overview_polyline?: { points: string };
      legs?: {
        distance?: { value: number };
        duration?: { value: number };
        steps?: {
          html_instructions?: string;
          distance?: { value: number };
          duration?: { value: number };
          maneuver?: string;
          start_location?: { lat: number; lng: number };
          end_location?: { lat: number; lng: number };
        }[];
      }[];
    }[];
  };
  try {
    const directionsRes = await fetch(
      `https://maps.googleapis.com/maps/api/directions/json?${params}`
    );
    directionsData = await directionsRes.json();
  } catch (err) {
    console.warn(
      `[routePolyline] Directions fetch threw: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    return {
      polyline: [
        [riderLat, riderLng],
        [destLat, destLng],
      ],
      distanceMeters: 0,
      durationSeconds: 0,
      steps: [],
      cached: false,
      fellBackToStraight: true,
    };
  }

  if (directionsData.status !== "OK" || !directionsData.routes?.[0]) {
    console.warn(
      `[routePolyline] Directions failed status=${directionsData.status} msg="${
        directionsData.error_message ?? ""
      }" origin=${riderLat},${riderLng} dest=${destLat},${destLng} target=${target}`
    );
    return {
      polyline: [
        [riderLat, riderLng],
        [destLat, destLng],
      ],
      distanceMeters: 0,
      durationSeconds: 0,
      steps: [],
      cached: false,
      fellBackToStraight: true,
    };
  }

  const route = directionsData.routes[0];
  const encoded = route.overview_polyline?.points ?? "";
  const polyline = decodePolyline(encoded);
  const leg = route.legs?.[0];
  const distanceMeters = leg?.distance?.value ?? 0;
  const durationSeconds = leg?.duration?.value ?? 0;

  // Decode the per-step maneuver list. Skipped if Directions didn't
  // return steps (rare — every Directions response has at least the
  // origin step). Plain-text instructions only; HTML is stripped here
  // so the client doesn't need to.
  const steps: RouteStep[] = (leg?.steps ?? [])
    .filter(
      (st) =>
        st.start_location?.lat != null &&
        st.start_location?.lng != null &&
        st.end_location?.lat != null &&
        st.end_location?.lng != null
    )
    .map((st) => ({
      instruction: stripHtml(st.html_instructions ?? ""),
      distanceM: st.distance?.value ?? 0,
      durationS: st.duration?.value ?? 0,
      maneuver: st.maneuver,
      startLat: st.start_location!.lat,
      startLng: st.start_location!.lng,
      endLat: st.end_location!.lat,
      endLng: st.end_location!.lng,
    }));

  routeCache.set(cacheKey, {
    polyline,
    distanceMeters,
    durationSeconds,
    steps,
    expiresAt: Date.now() + ROUTE_CACHE_TTL_MS,
  });
  recomputeState.set(orderId, {
    lastOriginLat: riderLat,
    lastOriginLng: riderLng,
    lastTarget: target,
    lastComputedAt: Date.now(),
  });

  return {
    polyline,
    distanceMeters,
    durationSeconds,
    steps,
    cached: false,
    fellBackToStraight: false,
  };
}

/**
 * Drop the per-order throttle state. Called from order-cleanup paths
 * (delivery completed/cancelled) so memory doesn't grow unbounded.
 */
export function clearRouteState(orderId: string): void {
  recomputeState.delete(orderId);
  for (const key of routeCache.keys()) {
    if (key.startsWith(`${orderId}:`)) routeCache.delete(key);
  }
}
