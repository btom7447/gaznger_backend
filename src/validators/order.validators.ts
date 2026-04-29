import { z } from "zod";

// Either an ObjectId (legacy `fuelId`) or a stable slug (new flow
// `fuelTypeId` like "petrol"/"diesel"/"kero"/"lpg"). Server resolves
// the slug to a FuelType ObjectId in the route handler.
export const createOrderSchema = z
  .object({
    fuelId: z.string().min(1).optional(),
    fuelTypeId: z.string().min(1).optional(),
    stationId: z.string().min(1, "Station ID is required"),
    quantity: z.number().positive("Quantity must be a positive number"),
    deliveryAddressId: z.string().min(1, "Delivery address is required"),
    // LPG-Swap return-trip ISO. Null = same-trip.
    returnSwapAt: z.string().datetime().nullable().optional(),
    note: z.string().max(500).optional(),
    cylinderType: z.string().optional(),
    deliveryType: z.enum(["cylinder_swap", "home_refill"]).optional(),
    cylinderImages: z.array(z.string()).optional(),
    // LPG-Swap details (brand / valve / age / test). All optional since
    // the customer can leave them blank and the rider inspects on arrival.
    cylinderDetails: z
      .object({
        brand: z.string().optional(),
        valve: z.string().optional(),
        age: z.string().optional(),
        test: z.string().optional(),
      })
      .optional(),
  })
  .refine((d) => d.fuelId || d.fuelTypeId, {
    message: "fuelId or fuelTypeId is required",
    path: ["fuelId"],
  });

export const updateOrderStatusSchema = z.object({
  status: z.enum(["pending", "confirmed", "assigned", "in-transit", "delivered", "cancelled"] as const, {
    error: "Invalid status value",
  }),
});

export const rateOrderSchema = z.object({
  // `score` is the legacy field (1..5 stars on the station). The new
  // customer Rate screen sends `stars` instead. Accept both — handler
  // resolves to the same value.
  score: z.number().int().min(1).max(5).optional(),
  stars: z.number().int().min(1).max(5).optional(),
  /** Free-form note the customer can leave for the rider. */
  comment: z.string().max(500).optional(),
  note: z.string().max(500).optional(),
  /** Quick-pick tags ("Fast", "Polite", etc.). */
  tags: z.array(z.string()).optional(),
  /** Tip in NGN whole units (no kobo). */
  tip: z.number().min(0).max(50_000).optional(),
}).refine((d) => d.score != null || d.stars != null, {
  message: "stars or score is required",
  path: ["stars"],
});
