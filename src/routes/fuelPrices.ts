/**
 * GET /api/fuel-prices
 *
 * Median per-unit price across active stations per fuel type. Drives
 * the FuelPriceRates strip on the customer Home (audit C.5). Cached
 * 5min in-memory because:
 *   - vendors don't update prices that often
 *   - the strip is informational ("market reference", not a quote)
 *   - cold-start cost is one $group aggregation; we'd rather pay it
 *     once per 5min than on every Home open
 *
 * Query params:
 *   - lat, lng (optional) — when both passed we constrain stations to
 *     a 25 km square so the rate reflects "stations near you" rather
 *     than the national median.
 *
 * Returns:
 *   { rates: [{ id: "petrol", label: "Petrol", amount: 800, unit: "L" }, …] }
 */
import { Router } from "express";
import GasStation from "../models/Station";
import FuelType from "../models/FuelType";
import { latLngSchema } from "../validators/latLng";

const router = Router();

interface CachedResult {
  rates: { id: string; label: string; amount: number; unit: string }[];
  expiresAt: number;
}
const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, CachedResult>();

// Customer-facing labels — fuel-type names in DB are "Petrol",
// "Diesel", "Gas", "Oil" but the home strip uses friendlier "LPG"
// and short-form "Kero". Map id → display label here so the client
// doesn't have to.
const FUEL_DISPLAY: Record<string, { id: string; label: string }> = {
  Petrol: { id: "petrol", label: "Petrol" },
  Diesel: { id: "diesel", label: "Diesel" },
  Gas: { id: "lpg", label: "LPG" },
  Oil: { id: "kero", label: "Kero" },
};

router.get("/", async (req, res) => {
  try {
    // P2 (audit run 4): validate via shared latLngSchema — `Number()`
    // alone let NaN/Infinity and out-of-range coords through into the
    // bounding-box filter.
    const coords = latLngSchema.safeParse({
      lat: Number(req.query.lat),
      lng: Number(req.query.lng),
    });
    const haveCoords = coords.success;
    const lat = haveCoords ? coords.data.lat : NaN;
    const lng = haveCoords ? coords.data.lng : NaN;

    // Cache key — round coords to 1dp (~11km) so nearby callers
    // share a hit. National median falls under the same key when
    // no coords are passed.
    const key = haveCoords
      ? `${lat.toFixed(1)},${lng.toFixed(1)}`
      : "national";
    const cached = cache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      return res.json({ rates: cached.rates });
    }

    // Bounding-box filter — 25km square is plenty for the "stations
    // near you" framing without requiring a 2dsphere index.
    const filter: Record<string, unknown> = { isActive: true };
    if (haveCoords) {
      const r = 25;
      const dLat = r / 111;
      const dLng = r / (111 * Math.cos((lat * Math.PI) / 180));
      filter["location.lat"] = { $gte: lat - dLat, $lte: lat + dLat };
      filter["location.lng"] = { $gte: lng - dLng, $lte: lng + dLng };
    }

    const fuelTypes = await FuelType.find().lean();
    const stations = await GasStation.find(filter).select("fuels").lean();

    const rates = fuelTypes
      .map((ft) => {
        const display = FUEL_DISPLAY[ft.name];
        if (!display) return null;
        const prices: number[] = [];
        for (const s of stations as Array<{ fuels?: Array<{ fuel?: unknown; pricePerUnit?: number; available?: boolean }> }>) {
          for (const f of s.fuels ?? []) {
            if (f.available === false) continue;
            const fid =
              (f.fuel as { _id?: { toString(): string } } | undefined)?._id?.toString?.() ??
              (f.fuel as { toString(): string } | undefined)?.toString?.();
            if (fid !== String(ft._id)) continue;
            if (typeof f.pricePerUnit === "number" && f.pricePerUnit > 0) {
              prices.push(f.pricePerUnit);
            }
          }
        }
        if (prices.length === 0) return null;
        prices.sort((a, b) => a - b);
        const mid = Math.floor(prices.length / 2);
        const median =
          prices.length % 2
            ? prices[mid]
            : Math.round((prices[mid - 1] + prices[mid]) / 2);
        return {
          id: display.id,
          label: display.label,
          amount: median,
          unit: ft.unit,
        };
      })
      .filter(Boolean) as CachedResult["rates"];

    cache.set(key, { rates, expiresAt: Date.now() + CACHE_TTL_MS });
    res.json({ rates });
  } catch (err) {
    console.error("[fuel-prices]", err);
    res.status(500).json({ message: "Failed to load fuel prices" });
  }
});

export default router;
