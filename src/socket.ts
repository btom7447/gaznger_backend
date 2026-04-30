import { Server } from "socket.io";
import { Server as HttpServer } from "http";
import jwt from "jsonwebtoken";
import Delivery from "./models/Delivery";
import { ACTIVE_DELIVERY_STATUSES, Rooms } from "./_shared";

/**
 * Structured socket log. Single line per event so it's easy to grep
 * production logs by event name, room, or user. Format:
 *
 *   [Socket] <action> event=<name> room=<room?> uid=<userId?> ms=<latency?>
 *
 * Phase 6 of the execution plan — without these logs, debugging a
 * "rider pin not showing" report meant adding console.logs and
 * waiting for the next repro. Now they're always there.
 */
function slog(
  action: "in" | "out" | "join" | "leave" | "conn" | "disc",
  fields: { event?: string; room?: string; uid?: string; ms?: number }
) {
  const parts: string[] = [`[Socket] ${action}`];
  if (fields.event) parts.push(`event=${fields.event}`);
  if (fields.room) parts.push(`room=${fields.room}`);
  if (fields.uid) parts.push(`uid=${fields.uid}`);
  if (fields.ms != null) parts.push(`ms=${fields.ms}`);
  console.log(parts.join(" "));
}

let io: Server | null = null;

/**
 * Reverse index — for any active delivery, the list of socket IDs
 * (one per device per role) that should receive its events. Maintained
 * in-memory because socket.io's room API is the same shape but doesn't
 * survive socket reconnects: when a rider's socket reconnects after
 * background → foreground, it gets a fresh socket id but we still
 * need to put it back in the right delivery rooms.
 *
 * Format: deliveryId → Set<userId>. We look up each user's room
 * (`user:<id>`) and join the latest socket from that room into the
 * delivery room, so reconnecting devices snap back into the right
 * rooms automatically.
 */
const deliveryMembers = new Map<string, Set<string>>();

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
    slog("conn", { uid: userId, room: Rooms.user(userId) });

    // Re-attach this socket to any delivery rooms its user is a
    // member of. Handles the foreground/background reconnect case
    // — without this, a rider whose phone backgrounded and woke up
    // 2 minutes later would silently miss every order:update for
    // their active delivery.
    for (const [deliveryId, members] of deliveryMembers.entries()) {
      if (members.has(userId)) {
        socket.join(Rooms.delivery(deliveryId));
      }
    }

    /**
     * Rider GPS relay.
     *
     * Phase 2 hot path: when the rider has an active delivery room,
     * we emit directly to the room — both the rider's own socket
     * and the customer's socket are members, so the customer
     * receives the ping in one hop with no DB lookup.
     *
     * Fallback: if the rider doesn't appear in any delivery room
     * (e.g. server restarted and lost in-memory state), do the
     * pre-Phase-2 DB-backed lookup. This keeps the relay resilient
     * across deploys without anyone noticing — the in-memory map
     * rebuilds within a few rider transitions.
     */
    socket.on("rider:location", async ({ lat, lng }: { lat: number; lng: number }) => {
      const startedAt = Date.now();
      try {
        // Fast path — find the delivery room this rider is in.
        let matchedDeliveryId: string | null = null;
        for (const [deliveryId, members] of deliveryMembers.entries()) {
          if (members.has(userId)) {
            matchedDeliveryId = deliveryId;
            break;
          }
        }

        if (matchedDeliveryId) {
          io!
            .to(Rooms.delivery(matchedDeliveryId))
            .emit("rider:location", { lat, lng, riderId: userId });
          slog("out", {
            event: "rider:location",
            room: Rooms.delivery(matchedDeliveryId),
            uid: userId,
            ms: Date.now() - startedAt,
          });
          return;
        }

        // Cold start fallback — DB lookup, then prime the room so
        // subsequent pings hit the fast path.
        const delivery = await Delivery.findOne({
          rider: userId,
          status: { $in: ACTIVE_DELIVERY_STATUSES as unknown as string[] },
        })
          .populate<{ order: { user: { toString(): string } } }>("order", "user")
          .lean();
        if (!delivery?.order) return;

        const customerId = delivery.order.user.toString();
        joinDeliveryRoom(String(delivery._id), [userId, customerId]);
        io!
          .to(Rooms.delivery(String(delivery._id)))
          .emit("rider:location", { lat, lng, riderId: userId });
        slog("out", {
          event: "rider:location (cold-path)",
          room: Rooms.delivery(String(delivery._id)),
          uid: userId,
          ms: Date.now() - startedAt,
        });
      } catch {
        // non-fatal — best-effort location relay
      }
    });

    socket.on("disconnect", () => {
      slog("disc", { uid: userId });
      // Don't tear down delivery membership on disconnect — the
      // user might just be backgrounding the app. We keep them in
      // the membership map so that when their reconnecting socket
      // joins, the loop at the top of the connection handler
      // re-adds them to the right rooms.
    });
  });

  return io;
}

/** Emit an event to a specific user (all their active sockets). */
export function emitToUser(userId: string, event: string, data: unknown): void {
  if (!io) return;
  io.to(Rooms.user(userId)).emit(event, data);
  slog("out", { event, room: Rooms.user(userId) });
}

/** Emit an event to every socket in a delivery room. */
export function emitToDelivery(
  deliveryId: string,
  event: string,
  data: unknown
): void {
  if (!io) return;
  io.to(Rooms.delivery(deliveryId)).emit(event, data);
  slog("out", { event, room: Rooms.delivery(deliveryId) });
}

/**
 * Add users to a delivery room. Called from the rider-accept route
 * (rider + customer both joined) and from the cold-start fallback in
 * the rider:location handler.
 *
 * Idempotent — calling twice with the same args is a no-op. We also
 * walk every currently-connected socket for each user and join it,
 * so multi-device users (rider on phone + admin on browser) all
 * receive room emits.
 */
export function joinDeliveryRoom(deliveryId: string, userIds: string[]): void {
  if (!io) return;
  let members = deliveryMembers.get(deliveryId);
  if (!members) {
    members = new Set();
    deliveryMembers.set(deliveryId, members);
  }
  for (const userId of userIds) {
    members.add(userId);
    // Walk every socket in the user's room and join the delivery
    // room. Sockets in a room are accessed via `io.sockets.adapter`.
    const userRoom = Rooms.user(userId);
    const socketIds = io.sockets.adapter.rooms.get(userRoom);
    if (socketIds) {
      for (const sid of socketIds) {
        const sock = io.sockets.sockets.get(sid);
        sock?.join(Rooms.delivery(deliveryId));
      }
    }
    slog("join", { uid: userId, room: Rooms.delivery(deliveryId) });
  }
}

/**
 * Remove a delivery room entirely. Call on terminal status
 * (delivered / dropped / cancelled) — every member socket leaves
 * automatically and the in-memory set is cleared.
 */
export function leaveDeliveryRoom(deliveryId: string): void {
  if (!io) return;
  io.in(Rooms.delivery(deliveryId)).socketsLeave(Rooms.delivery(deliveryId));
  deliveryMembers.delete(deliveryId);
  slog("leave", { room: Rooms.delivery(deliveryId) });
}
