import { Server } from "socket.io";
import { Server as HttpServer } from "http";
import jwt from "jsonwebtoken";
import Delivery from "./models/Delivery";

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
    socket.join(`user:${userId}`);
    console.log(`[Socket] connected uid=${userId} sid=${socket.id}`);

    // Relay rider location to the customer who has the active order
    socket.on("rider:location", async ({ lat, lng }: { lat: number; lng: number }) => {
      try {
        const delivery = await Delivery.findOne({
          rider: userId,
          status: { $in: ["accepted", "picked_up"] },
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
  io.to(`user:${userId}`).emit(event, data);
}
