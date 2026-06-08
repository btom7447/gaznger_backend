// P2 (audit run 4): shared lat/lng zod schema. Rejects NaN/Infinity and
// out-of-range values. Used by routes that accept raw coordinates from
// the client (rider location patch, fuel-prices/stations bounding-box
// queries) — previously each accepted `Number(x)` blindly which let
// NaN/Infinity through to the Mongo filter.
import { z } from "zod";

export const latLngSchema = z.object({
  lat: z.number().finite().gte(-90).lte(90),
  lng: z.number().finite().gte(-180).lte(180),
});
