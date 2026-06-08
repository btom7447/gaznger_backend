import { Server } from "socket.io";
import { Server as HttpServer } from "http";
import Delivery from "./models/Delivery";
import User from "./models/User";
import { ACTIVE_DELIVERY_STATUSES, Rooms } from "./_shared";
import { verifyToken } from "./utils/jwt";
import {
  computeRoute,
  routeTargetForStatus,
  shouldRecomputeRoute,
} from "./utils/routePolyline";

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

/**
 * deliveryId → assigned riderId. Populated on rider-accept (via
 * joinDeliveryRoom) and the cold-start fallback in the rider:location
 * handler. Used to verify ownership before relaying GPS pings — without
 * this, a malicious customer in the same delivery room could emit
 * `rider:location` and have the server broadcast their fake coords as
 * if from the rider (audit A.2).
 *
 * Reads are O(1) and don't require a DB roundtrip; map is rebuilt
 * lazily on first ping after a server restart.
 */
const deliveryRiderById = new Map<string, string>();

/**
 * accountStatus cache (audit E.6): JWT verification alone doesn't
 * catch a user whose account was suspended/deleted between login and
 * socket connect. Look up `accountStatus` once per minute per user,
 * cache the result so happy-path connects don't pay a DB round-trip.
 *
 * Negative result (rejected) isn't cached — re-issuing a valid JWT
 * after reinstatement should let the user back in immediately.
 */
const accountStatusCache = new Map<string, { allowed: boolean; expiresAt: number }>();
const ACCOUNT_STATUS_TTL_MS = 60_000;

async function isAccountAllowed(userId: string): Promise<boolean> {
  const now = Date.now();
  const hit = accountStatusCache.get(userId);
  if (hit && hit.expiresAt > now) return hit.allowed;
  try {
    const user = await User.findById(userId).select("accountStatus").lean();
    const status = (user as any)?.accountStatus;
    const allowed = !user || (status !== "suspended" && status !== "deleted");
    if (allowed) {
      accountStatusCache.set(userId, { allowed: true, expiresAt: now + ACCOUNT_STATUS_TTL_MS });
    }
    return allowed;
  } catch {
    // DB hiccup — fail open so a transient outage doesn't lock
    // every legitimate socket out. The next heartbeat re-checks.
    return true;
  }
}

export function initSocket(httpServer: HttpServer): Server {
  // SECURITY (audit A.3): mirror the Express CORS allowlist on the
  // Socket.IO upgrade. `origin: "*"` previously let any browser tab
  // open a websocket; combined with the rider-spoof bug (A.2) it
  // widened the abuse surface beyond the mobile app. Same parsing as
  // app.ts so the two stay in sync.
  const allowedOrigins = process.env.ALLOWED_ORIGINS
    ?.split(",")
    .map((o) => o.trim())
    .filter(Boolean);
  const corsOrigin =
    process.env.NODE_ENV === "production"
      ? (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
          // No origin = native mobile / non-browser; always allow.
          if (!origin) return callback(null, true);
          if (allowedOrigins && allowedOrigins.includes(origin)) {
            return callback(null, true);
          }
          callback(new Error(`CORS: origin ${origin} not allowed`));
        }
      : true;

  io = new Server(httpServer, {
    cors: { origin: corsOrigin, methods: ["GET", "POST"], credentials: true },
    transports: ["websocket", "polling"],
  });

  io.use(async (socket, next) => {
    const token = socket.handshake.auth?.token as string | undefined;
    if (!token) return next(new Error("unauthorized"));
    try {
      // SEC-P1 (audit run 5): use the shared verifyToken() helper
      // instead of raw jwt.verify. The helper enforces issuer
      // ('gaznger-api') + audience ('gaznger-mobile') checks and
      // honors the JWT_SECRET_NEXT rotation-window fallback. Pre-fix
      // the inline `jwt.verify(token, process.env.JWT_SECRET!)`
      // bypassed BOTH:
      //   - issuer/audience: a token minted by another Gaznger
      //     service with the same secret but different audience
      //     would be accepted by the socket but not by the REST API.
      //   - rotation window: every active client gets kicked 15min
      //     early during a secret rotation because the socket only
      //     knows the old secret.
      const payload = verifyToken(token) as
        | { id?: string; userId?: string }
        | null;
      if (!payload) return next(new Error("invalid token"));
      const userId = payload.id ?? payload.userId;
      if (!userId) return next(new Error("invalid token"));

      // SECURITY (audit E.6): the JWT can outlive an account
      // suspension by up to 15 min. Re-check accountStatus on connect
      // so a banned user can't keep emitting GPS / receiving updates.
      const allowed = await isAccountAllowed(userId);
      if (!allowed) return next(new Error("account suspended"));

      socket.data.userId = userId;
      next();
    } catch {
      next(new Error("invalid token"));
    }
  });

  io.on("connection", async (socket) => {
    const userId = socket.data.userId as string;
    socket.join(Rooms.user(userId));
    slog("conn", { uid: userId, room: Rooms.user(userId) });

    // P1-3 (audit run 1): auto-join admin sockets to the broadcast
    // room. We do this from a lazy lookup (one DB read on connect)
    // rather than embedding role in the JWT — the JWT is short-lived
    // by design (15 min) and we don't want a role change to wait
    // for a refresh. Cached for the connection lifetime so a long-
    // lived admin connection doesn't repeatedly query.
    try {
      const user = await User.findById(userId).select("role").lean();
      if ((user as any)?.role === "admin") {
        socket.join(Rooms.admin);
        slog("join", { uid: userId, room: Rooms.admin });
      }
    } catch {
      // non-fatal — role check failures fall back to user-room only.
    }

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
        // SECURITY (audit A.2): we MUST verify the emitter is actually
        // the assigned rider before relaying. Without this, a customer
        // in the same delivery room can emit `rider:location` and have
        // the server broadcast their fake coords as if from the rider
        // (also burns Directions API quota via maybeRecomputeAnd…).
        let matchedDeliveryId: string | null = null;
        for (const [deliveryId, members] of deliveryMembers.entries()) {
          if (members.has(userId)) {
            const cachedRiderId = deliveryRiderById.get(deliveryId);
            if (cachedRiderId === userId) {
              matchedDeliveryId = deliveryId;
              break;
            }
            // emitter is a member of the delivery room (e.g. customer)
            // but not the rider — skip silently. We don't `return` yet:
            // a rider may be in multiple rooms (rare, race conditions).
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
          // Throttled route recompute + broadcast. Reads the live
          // delivery status to pick the leg, then defers to the
          // helper's distance + time gates. Best-effort: a failed
          // recompute doesn't break the GPS relay above.
          await maybeRecomputeAndBroadcastRoute(matchedDeliveryId, lat, lng);
          return;
        }

        // Cold start fallback — DB lookup, then prime the room AND the
        // rider-id cache so subsequent pings hit the fast path.
        const delivery = await Delivery.findOne({
          rider: userId,
          status: { $in: ACTIVE_DELIVERY_STATUSES as unknown as string[] },
        })
          .populate<{ order: { user: { toString(): string } } }>("order", "user")
          .lean();
        if (!delivery?.order) {
          // Not the assigned rider on any active delivery → no relay.
          // Logged at debug for security visibility.
          slog("out", {
            event: "rider:location (rejected: not assigned)",
            uid: userId,
          });
          return;
        }

        const customerId = delivery.order.user.toString();
        joinDeliveryRoom(String(delivery._id), [userId, customerId]);
        deliveryRiderById.set(String(delivery._id), userId);
        io!
          .to(Rooms.delivery(String(delivery._id)))
          .emit("rider:location", { lat, lng, riderId: userId });
        slog("out", {
          event: "rider:location (cold-path)",
          room: Rooms.delivery(String(delivery._id)),
          uid: userId,
          ms: Date.now() - startedAt,
        });
        await maybeRecomputeAndBroadcastRoute(String(delivery._id), lat, lng);
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

/**
 * Emit an event to every connected admin.
 *
 * P1-3 (audit run 1): admin-web pre-fix had ZERO socket subscriptions
 * and the server had no `admin` room. Critical ops events (`dispute:opened`,
 * `withdrawal:failed`, `reconcile:drift`, new `verification:submitted`)
 * were emitted to the affected USER's room only — admins were blind
 * to all of them until the next 15-60s poll on a screen that even
 * polled (disputes/page.tsx pre-fix never refetched at all).
 *
 * Use for any state change that ops must see in real-time. For
 * user-affecting events (which also need ops visibility), call BOTH
 * `emitToUser` (for the user) AND `emitToAdmins` (for the room).
 */
export function emitToAdmins(event: string, data: unknown): void {
  if (!io) return;
  io.to(Rooms.admin).emit(event, data);
  slog("out", { event, room: Rooms.admin });
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
  deliveryRiderById.delete(deliveryId);
  slog("leave", { room: Rooms.delivery(deliveryId) });
}

/**
 * Record the assigned rider for a delivery so the rider:location
 * handler can verify ownership without a DB roundtrip on every ping.
 *
 * SECURITY (audit A.2): paired with the verification check in the
 * `rider:location` handler. Without this, a customer in the same
 * delivery room could spoof rider GPS pings.
 *
 * Idempotent — safe to call on re-acceptance flows.
 */
export function setDeliveryRider(deliveryId: string, riderId: string): void {
  deliveryRiderById.set(deliveryId, riderId);
}

/**
 * Recompute the rider→target route for a delivery if the throttle
 * gate allows, then broadcast the result to the delivery room. Used
 * by:
 *   - rider:location handler (every GPS ping → maybe recompute)
 *   - emitRouteUpdateForDelivery (phase-transition trigger called
 *     from order status-change handlers)
 *
 * Returns silently when:
 *   - delivery not found / no longer active
 *   - status doesn't map to a route target (pre-pickup w/o accept)
 *   - throttle gate says skip (haven't moved enough / too soon)
 *   - computeRoute returns null (missing coords) or fell back to
 *     a straight line (already-logged Directions failure)
 */
async function maybeRecomputeAndBroadcastRoute(
  deliveryId: string,
  riderLat: number,
  riderLng: number,
  force = false
): Promise<void> {
  try {
    const delivery = await Delivery.findById(deliveryId)
      .select("order status")
      .lean();
    if (!delivery) return;
    const target = routeTargetForStatus(delivery.status as string);
    if (!target) return;
    const orderId = String(delivery.order);
    if (!shouldRecomputeRoute(orderId, riderLat, riderLng, target, force)) {
      return;
    }
    const result = await computeRoute(orderId, riderLat, riderLng, target);
    if (!result || result.fellBackToStraight) return;
    if (!io) return;
    io.to(Rooms.delivery(deliveryId)).emit("route:update", {
      orderId,
      polyline: result.polyline,
      distanceM: result.distanceMeters,
      durationS: result.durationSeconds,
      steps: result.steps,
      target,
    });
    slog("out", {
      event: "route:update",
      room: Rooms.delivery(deliveryId),
    });
  } catch {
    // non-fatal — Directions failures already logged in computeRoute
  }
}

/**
 * Force a fresh route recompute + broadcast for a delivery. Called
 * from order status-change handlers when the leg flips (target
 * station→destination on pickup) so the customer doesn't see a
 * stale "rider→station" polyline for up to one GPS interval after
 * the rider taps "Picked up".
 *
 * Resolves the rider's last-known GPS from RiderProfile when the
 * caller doesn't pass coords. Returns silently if there's nothing
 * to compute against (no rider GPS yet, status pre-acceptance).
 */
export async function emitRouteUpdateForDelivery(
  deliveryId: string,
  riderLat?: number,
  riderLng?: number
): Promise<void> {
  if (!io) return;
  try {
    let lat = riderLat;
    let lng = riderLng;
    if (lat == null || lng == null) {
      // Lazy import to avoid circular module load (RiderProfile →
      // models/User → utils → socket).
      const RiderProfile = (await import("./models/RiderProfile")).default;
      const delivery = await Delivery.findById(deliveryId)
        .select("rider")
        .lean();
      if (!delivery?.rider) return;
      const profile = await RiderProfile.findOne({ user: delivery.rider })
        .select("currentLocation")
        .lean();
      if (!profile?.currentLocation?.lat || !profile?.currentLocation?.lng) {
        return;
      }
      lat = profile.currentLocation.lat;
      lng = profile.currentLocation.lng;
    }
    await maybeRecomputeAndBroadcastRoute(deliveryId, lat, lng, true);
  } catch {
    // non-fatal
  }
}
