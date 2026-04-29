import { z } from "zod";

export const createOrderSchema = z.object({
  fuelId: z.string().min(1, "Fuel ID is required"),
  stationId: z.string().min(1, "Station ID is required"),
  quantity: z.number().positive("Quantity must be a positive number"),
  deliveryAddressId: z.string().min(1, "Delivery address is required"),
  cylinderType: z.string().optional(),
  deliveryType: z.enum(["cylinder_swap", "home_refill"]).optional(),
  cylinderImages: z.array(z.string()).optional(),
});

export const updateOrderStatusSchema = z.object({
  status: z.enum(["pending", "confirmed", "assigned", "in-transit", "delivered", "cancelled"] as const, {
    error: "Invalid status value",
  }),
});

export const rateOrderSchema = z.object({
  score: z.number().int().min(1, "Score must be at least 1").max(5, "Score must be at most 5"),
  comment: z.string().max(500).optional(),
});
