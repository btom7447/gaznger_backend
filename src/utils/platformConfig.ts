import PlatformConfig, { IPlatformConfig } from "../models/PlatformConfig";

/**
 * In-memory cache for the singleton PlatformConfig doc. 60s TTL — short
 * enough that admin commission changes propagate quickly, long enough to
 * not hammer the DB on every order.
 *
 * Mutating endpoints (admin updates) call `invalidatePlatformConfig()`
 * after writing so the next read sees fresh data immediately.
 */
let cache: { value: IPlatformConfig; expiresAt: number } | null = null;
const CACHE_TTL_MS = 60_000;

export async function getPlatformConfig(): Promise<IPlatformConfig> {
  if (cache && cache.expiresAt > Date.now()) {
    return cache.value;
  }
  let doc = await PlatformConfig.findOne({ key: "main" });
  if (!doc) {
    // First boot — create with schema defaults.
    doc = await PlatformConfig.create({ key: "main" });
  }
  cache = { value: doc, expiresAt: Date.now() + CACHE_TTL_MS };
  return doc;
}

export function invalidatePlatformConfig(): void {
  cache = null;
}

/**
 * Per-role commission rate. Always returns the platform default today;
 * the per-vendor / per-rider override path will hook in here when added.
 */
export async function getCommissionRate(
  role: "vendor" | "rider",
  // _userId reserved for the override path; unused for now.
  _userId?: string
): Promise<number> {
  const cfg = await getPlatformConfig();
  return role === "vendor" ? cfg.vendorCommission : cfg.riderCommission;
}
