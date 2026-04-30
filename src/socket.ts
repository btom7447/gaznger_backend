import { Server } from "socket.io";
import { Server as HttpServer } from "http";
import jwt from "jsonwebtoken";
import Delivery from "./models/Delivery";
import { ACTIVE_DELIVERY_STATUSES, Rooms } from "./_shared";

let io: Server | null = null;

export function initSocket(httpServer: HttpServer): Server {
  io = new Server(httpServer, {
    cors: { origin: "*", methods: ["GET", "POST"] },
    transports: ["websocket", "polling"],
  });

  io.use((socket, next) => {
    const token = socket.handshake.auth?.token as string | undefined;
    if (!token) return next(new Error("unauthorized"));
    try {
      const payload = jwt.verify(token, process.env.JWT_SECRET!) as { userId: string };
      socket.data.userId = payload.userId;
      next();
    } catch {
      next(new Error("invalid token"));
    }
  });

  io.on("connection", (socket) => {
    const userId = socket.data.userId as string;
    socket.join(Rooms.user(userId));
    console.log(`[Socket] connected uid=${userId} sid=${socket.id}`);

    /**
     * Relay rider GPS to the customer with the active order.
     *
     * Whitelist comes from `_shared/status.ts` (ACTIVE_DELIVERY_STATUSES)
     * — the same set the rider's `/active` endpoint uses, so the
     * relay can never drift from "what the rider considers an active
     * job." Phase 2 of the execution plan replaces this DB lookup
     * with a per-delivery socket room — at that point this handler
     * becomes `socket.to(deliveryRoom).emit(...)` with no DB hit.
     */
    socket.on("rider:location", async ({ lat, lng }: { lat: number; lng: number }) => {
      try {
        const delivery = await Delivery.findOne({
          rider: userId,
          status: { $in: ACTIVE_DELIVERY_STATUSES as unknown as string[] },
        })
          .populate<{ order: { user: { toString(): string } } }>("order", "user")
          .lean();

        if (!delivery?.order) return;
        const customerId = delivery.order.user.toString();
        emitToUser(customerId, "rider:location", { lat, lng, riderId: userId });
      } catch {
        // non-fatal — best-effort location relay
      }
    });

    socket.on("disconnect", () => {
      console.log(`[Socket] disconnected uid=${userId}`);
    });
  });

  return io;
}

/** Emit an event to a specific user (all their active sockets). */
export function emitToUser(userId: string, event: string, data: unknown): void {
  if (!io) return;
  io.to(Rooms.user(userId)).emit(event, data);
}
