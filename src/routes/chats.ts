import { Router } from "express";
import mongoose from "mongoose";
import { requireAuth } from "../middleware/auth";
import Chat, { type ChatRole, canonicalChatKey } from "../models/Chat";
import Message from "../models/Message";
import Order from "../models/Order";
import User from "../models/User";
import GasStation from "../models/Station";
import RiderProfile from "../models/RiderProfile";
import { emitToUser } from "../socket";

const router = Router();

/**
 * Chat REST surface — one-to-one threads between user pairs.
 *
 *   GET    /api/chats                          List my threads
 *   GET    /api/chats/:id                      Thread metadata + recent msgs
 *   GET    /api/chats/:id/messages             Paginated message history
 *   POST   /api/chats                          Open/get thread with (peerUserId, peerRole, orderRef?)
 *   POST   /api/chats/:id/messages             Send a text message
 *   POST   /api/chats/:id/read                 Mark thread read (zeroes unread)
 *
 *   Special:
 *   POST   /api/chats/support                  Get-or-create thread with support
 *
 * Authorization rules (per chat.ts header doc):
 *
 *   - customer ↔ rider    must share an Order
 *   - customer ↔ vendor   must share an Order (customer at vendor's station)
 *   - vendor   ↔ rider    rider must have delivered for vendor (or active)
 *   - any user ↔ support  always allowed
 *
 * The /chats POST + /chats/support endpoints encode these rules; the
 * GET endpoints rely on participant membership in the chat row.
 */

/**
 * Resolve a synthetic "Gaznger Support" user id. We pick the first
 * admin user (role: "admin") so message bubbles render with a real
 * name. Cached at module level to avoid the DB hit on every chat
 * open — admins are not added/removed frequently.
 */
let cachedSupportUserId: string | null = null;
async function getSupportUserId(): Promise<string | null> {
  if (cachedSupportUserId) return cachedSupportUserId;
  const admin = await User.findOne({ role: "admin" }).select("_id").lean();
  cachedSupportUserId = admin ? String((admin as any)._id) : null;
  return cachedSupportUserId;
}

function meRole(req: any): ChatRole {
  const r = req.userRole ?? req.user?.role;
  if (r === "vendor" || r === "rider" || r === "customer" || r === "admin")
    return r;
  return "customer";
}

interface ChatRowLite {
  _id: mongoose.Types.ObjectId;
  participants: Array<{
    user: mongoose.Types.ObjectId;
    role: ChatRole;
    unread: number;
    lastReadAt?: Date;
  }>;
  orderRef?: mongoose.Types.ObjectId;
  bulkRef?: mongoose.Types.ObjectId;
  lastMessageAt?: Date;
  lastMessagePreview?: string;
  createdAt: Date;
  updatedAt: Date;
}

// ===================== AUTHORIZATION HELPERS =====================

async function canChat(
  meId: string,
  meRoleVal: ChatRole,
  peerId: string,
  peerRole: ChatRole,
  orderRef?: string,
): Promise<{ allowed: true } | { allowed: false; reason: string }> {
  if (meId === peerId) return { allowed: false, reason: "Can't message yourself" };
  if (peerRole === "support" || meRoleVal === "support" || meRoleVal === "admin")
    return { allowed: true };
  if (peerRole === "admin") return { allowed: true };

  const pair = [meRoleVal, peerRole].sort().join(":");

  // customer ↔ rider: must share an order
  if (pair === "customer:rider") {
    const q: Record<string, unknown> = { user: meRoleVal === "customer" ? meId : peerId, riderId: meRoleVal === "rider" ? meId : peerId };
    if (orderRef) q._id = orderRef;
    const order = await Order.findOne(q).select("_id").lean();
    if (!order) return { allowed: false, reason: "Not on a shared order" };
    return { allowed: true };
  }

  // customer ↔ vendor: customer must have ordered at a station this vendor owns
  if (pair === "customer:vendor") {
    const customerId = meRoleVal === "customer" ? meId : peerId;
    const vendorId = meRoleVal === "vendor" ? meId : peerId;
    const vendorStationIds = await GasStation.find({ vendorId })
      .select("_id")
      .lean();
    const ids = vendorStationIds.map((s) => s._id);
    if (ids.length === 0)
      return { allowed: false, reason: "Vendor has no stations" };
    const q: Record<string, unknown> = {
      user: customerId,
      station: { $in: ids },
    };
    if (orderRef) q._id = orderRef;
    const order = await Order.findOne(q).select("_id").lean();
    if (!order)
      return { allowed: false, reason: "No order links you two" };
    return { allowed: true };
  }

  // vendor ↔ rider: rider must have delivered (or be assigned to) an
  // order at one of the vendor's stations.
  if (pair === "rider:vendor") {
    const vendorId = meRoleVal === "vendor" ? meId : peerId;
    const riderId = meRoleVal === "rider" ? meId : peerId;
    const stationIds = await GasStation.find({ vendorId })
      .select("_id")
      .lean();
    const ids = stationIds.map((s) => s._id);
    if (ids.length === 0)
      return { allowed: false, reason: "Vendor has no stations" };
    const order = await Order.findOne({
      riderId,
      station: { $in: ids },
    })
      .select("_id")
      .lean();
    if (!order)
      return { allowed: false, reason: "No order links you two" };
    return { allowed: true };
  }

  return { allowed: false, reason: "Not allowed" };
}

// ===================== LIST MY THREADS =====================
router.get("/", requireAuth, async (req: any, res) => {
  try {
    const meId = String(req.userId);
    const threads = (await Chat.find({ "participants.user": meId })
      .sort({ lastMessageAt: -1, updatedAt: -1 })
      .limit(50)
      .populate({
        path: "participants.user",
        select: "displayName profileImage role",
      })
      .lean()) as any[];

    const rows = threads.map((t) => {
      const me = t.participants.find((p: any) => String(p.user._id ?? p.user) === meId);
      const peer = t.participants.find((p: any) => String(p.user._id ?? p.user) !== meId);
      return {
        id: String(t._id),
        peer: peer
          ? {
              id: String(peer.user._id ?? peer.user),
              displayName: peer.user.displayName ?? "User",
              profileImage: peer.user.profileImage ?? null,
              role: peer.role,
            }
          : null,
        unread: me?.unread ?? 0,
        orderRef: t.orderRef ? String(t.orderRef) : null,
        bulkRef: t.bulkRef ? String(t.bulkRef) : null,
        lastMessageAt: t.lastMessageAt ?? t.updatedAt,
        lastMessagePreview: t.lastMessagePreview ?? "",
      };
    });
    res.json({ threads: rows });
  } catch (err) {
    console.error("[chats list]", err);
    res.status(500).json({ message: "Failed to fetch chats" });
  }
});

// ===================== UNREAD SUMMARY =====================
/**
 * Lightweight roll-up for header badges. Returns the sum of unread
 * messages across all of my threads. Polled on app foreground +
 * updated live by `chat:message` socket events.
 */
router.get("/unread-summary", requireAuth, async (req: any, res) => {
  try {
    const meId = String(req.userId);
    const agg = await Chat.aggregate([
      { $match: { "participants.user": new mongoose.Types.ObjectId(meId) } },
      { $unwind: "$participants" },
      { $match: { "participants.user": new mongoose.Types.ObjectId(meId) } },
      { $group: { _id: null, total: { $sum: "$participants.unread" } } },
    ]);
    res.json({ unread: agg[0]?.total ?? 0 });
  } catch (err) {
    res.status(500).json({ message: "Failed to fetch unread" });
  }
});

// ===================== OPEN OR CREATE THREAD =====================
/**
 * POST /api/chats { peerUserId, peerRole, orderRef?, bulkRef? }
 *
 * Idempotent. If a thread already exists for the canonical key,
 * returns it; otherwise creates one (only if the authorization
 * check passes).
 */
router.post("/", requireAuth, async (req: any, res) => {
  try {
    const meId = String(req.userId);
    const meRoleVal = meRole(req);
    const { peerUserId, peerRole, orderRef, bulkRef } = req.body as {
      peerUserId?: string;
      peerRole?: ChatRole;
      orderRef?: string;
      bulkRef?: string;
    };
    if (!peerUserId || !peerRole) {
      return res
        .status(400)
        .json({ message: "peerUserId and peerRole required" });
    }

    const check = await canChat(
      meId,
      meRoleVal,
      peerUserId,
      peerRole,
      orderRef,
    );
    if (!check.allowed) {
      return res.status(403).json({ message: check.reason });
    }

    const key = canonicalChatKey(meId, peerUserId);
    const existing = await Chat.findOne({ key });
    if (existing) {
      return res.json({ chat: existing });
    }

    const chat = await Chat.create({
      key,
      participants: [
        { user: new mongoose.Types.ObjectId(meId), role: meRoleVal, unread: 0 },
        {
          user: new mongoose.Types.ObjectId(peerUserId),
          role: peerRole,
          unread: 0,
        },
      ],
      orderRef: orderRef ? new mongoose.Types.ObjectId(orderRef) : undefined,
      bulkRef: bulkRef ? new mongoose.Types.ObjectId(bulkRef) : undefined,
    });
    res.status(201).json({ chat });
  } catch (err) {
    console.error("[chats open]", err);
    res.status(500).json({ message: "Failed to open thread" });
  }
});

// ===================== OPEN SUPPORT THREAD =====================
router.post("/support", requireAuth, async (req: any, res) => {
  try {
    const meId = String(req.userId);
    const meRoleVal = meRole(req);
    const supportId = await getSupportUserId();
    if (!supportId) {
      return res
        .status(503)
        .json({ message: "Support is offline. Try again later." });
    }
    const key = canonicalChatKey(meId, supportId);
    const existing = await Chat.findOne({ key });
    if (existing) return res.json({ chat: existing });
    const chat = await Chat.create({
      key,
      participants: [
        { user: new mongoose.Types.ObjectId(meId), role: meRoleVal, unread: 0 },
        {
          user: new mongoose.Types.ObjectId(supportId),
          role: "support",
          unread: 0,
        },
      ],
    });
    res.status(201).json({ chat });
  } catch (err) {
    console.error("[chats support]", err);
    res.status(500).json({ message: "Failed to open support" });
  }
});

// ===================== THREAD DETAIL =====================
router.get("/:id", requireAuth, async (req: any, res) => {
  try {
    const idStr = Array.isArray(req.params.id)
      ? req.params.id[0]
      : (req.params.id as string);
    const meId = String(req.userId);
    const chat = (await Chat.findById(idStr)
      .populate({
        path: "participants.user",
        select: "displayName profileImage role",
      })
      .lean()) as any;
    if (!chat) return res.status(404).json({ message: "Thread not found" });
    if (!chat.participants.some((p: any) => String(p.user._id ?? p.user) === meId))
      return res.status(403).json({ message: "Not a participant" });
    res.json({ chat });
  } catch (err) {
    res.status(500).json({ message: "Failed to fetch thread" });
  }
});

// ===================== MESSAGE HISTORY =====================
router.get("/:id/messages", requireAuth, async (req: any, res) => {
  try {
    const idStr = Array.isArray(req.params.id)
      ? req.params.id[0]
      : (req.params.id as string);
    const meId = String(req.userId);
    const chat = await Chat.findById(idStr).lean();
    if (!chat) return res.status(404).json({ message: "Thread not found" });
    if (!(chat as any).participants.some((p: any) => String(p.user) === meId))
      return res.status(403).json({ message: "Not a participant" });

    const { before, limit = "50" } = req.query as Record<string, string>;
    const limitNum = Math.min(200, Math.max(1, parseInt(limit, 10)));
    const q: Record<string, unknown> = { chat: idStr };
    if (before) q.createdAt = { $lt: new Date(before) };

    const docs = await Message.find(q)
      .sort({ createdAt: -1 })
      .limit(limitNum)
      .lean();
    // Reverse so client renders oldest→newest in the message list.
    res.json({ messages: docs.reverse() });
  } catch (err) {
    res.status(500).json({ message: "Failed to fetch messages" });
  }
});

// ===================== SEND MESSAGE =====================
router.post("/:id/messages", requireAuth, async (req: any, res) => {
  try {
    const idStr = Array.isArray(req.params.id)
      ? req.params.id[0]
      : (req.params.id as string);
    const meId = String(req.userId);
    const { text, attachments } = req.body as {
      text?: string;
      attachments?: Array<{
        kind: "image" | "video";
        url: string;
        thumbUrl?: string;
        width?: number;
        height?: number;
        durationSec?: number;
        mime?: string;
      }>;
    };
    const cleanText = (text ?? "").trim();
    const safeAttachments = Array.isArray(attachments)
      ? attachments
          .filter((a) => a && (a.kind === "image" || a.kind === "video") && typeof a.url === "string" && a.url)
          .slice(0, 9)
      : [];
    if (!cleanText && safeAttachments.length === 0) {
      return res
        .status(400)
        .json({ message: "text or attachments required" });
    }

    const chat = await Chat.findById(idStr);
    if (!chat) return res.status(404).json({ message: "Thread not found" });
    const me = (chat as any).participants.find(
      (p: any) => String(p.user) === meId,
    );
    if (!me) return res.status(403).json({ message: "Not a participant" });

    const msg = await Message.create({
      chat: chat._id,
      sender: new mongoose.Types.ObjectId(meId),
      kind: "text",
      text: cleanText,
      attachments: safeAttachments,
      readBy: [
        { user: new mongoose.Types.ObjectId(meId), at: new Date() },
      ],
    });

    // Preview line — text wins, otherwise an attachment-count placeholder
    // so the thread list shows "📷 Photo" / "🎥 Video" / "📎 N attachments".
    const preview = cleanText
      ? cleanText.slice(0, 140)
      : safeAttachments.length === 1
        ? safeAttachments[0].kind === "image"
          ? "📷 Photo"
          : "🎥 Video"
        : `📎 ${safeAttachments.length} attachments`;

    // Bump unread for every OTHER participant; reset for me.
    (chat as any).participants = (chat as any).participants.map((p: any) => {
      if (String(p.user) === meId) {
        return { ...p, unread: 0, lastReadAt: new Date() };
      }
      return { ...p, unread: (p.unread ?? 0) + 1 };
    });
    (chat as any).lastMessageAt = (msg as any).createdAt;
    (chat as any).lastMessagePreview = preview;
    await chat.save();

    // Emit to every participant (including sender, for multi-device).
    for (const p of (chat as any).participants) {
      emitToUser(String(p.user), "chat:message", {
        chatId: String(chat._id),
        message: msg,
      });
    }
    res.status(201).json({ message: msg });
  } catch (err) {
    console.error("[chats send]", err);
    res.status(500).json({ message: "Failed to send" });
  }
});

// ===================== SOFT-DELETE MESSAGE =====================
/**
 * DELETE /api/chats/:id/messages/:mid
 *
 * Sender soft-deletes their own message. Row stays in Mongo with
 * `deletedAt`/`deletedBy` set; client renders a tombstone bubble.
 * Admin can delete any message in any thread.
 */
router.delete("/:id/messages/:mid", requireAuth, async (req: any, res) => {
  try {
    const chatIdStr = Array.isArray(req.params.id)
      ? req.params.id[0]
      : (req.params.id as string);
    const msgIdStr = Array.isArray(req.params.mid)
      ? req.params.mid[0]
      : (req.params.mid as string);
    const meId = String(req.userId);

    const chat = await Chat.findById(chatIdStr);
    if (!chat) return res.status(404).json({ message: "Thread not found" });
    if (!(chat as any).participants.some((p: any) => String(p.user) === meId))
      return res.status(403).json({ message: "Not a participant" });

    const msg = await Message.findOne({ _id: msgIdStr, chat: chatIdStr });
    if (!msg) return res.status(404).json({ message: "Message not found" });
    if (msg.deletedAt) return res.json({ message: msg });

    const meRoleVal = meRole(req);
    if (String(msg.sender ?? "") !== meId && meRoleVal !== "admin") {
      return res
        .status(403)
        .json({ message: "Only the sender can delete this message" });
    }

    msg.deletedAt = new Date();
    msg.deletedBy = new mongoose.Types.ObjectId(meId);
    await msg.save();

    // Broadcast to every participant so threads update in real time.
    for (const p of (chat as any).participants) {
      emitToUser(String(p.user), "chat:message-deleted", {
        chatId: String(chat._id),
        messageId: String(msg._id),
        deletedAt: msg.deletedAt,
      });
    }
    res.json({ message: msg });
  } catch (err) {
    console.error("[chats delete-message]", err);
    res.status(500).json({ message: "Failed to delete message" });
  }
});

// ===================== MARK THREAD READ =====================
router.post("/:id/read", requireAuth, async (req: any, res) => {
  try {
    const idStr = Array.isArray(req.params.id)
      ? req.params.id[0]
      : (req.params.id as string);
    const meId = String(req.userId);
    const chat = await Chat.findById(idStr);
    if (!chat) return res.status(404).json({ message: "Thread not found" });
    const me = (chat as any).participants.find(
      (p: any) => String(p.user) === meId,
    );
    if (!me) return res.status(403).json({ message: "Not a participant" });

    (chat as any).participants = (chat as any).participants.map((p: any) => {
      if (String(p.user) === meId) {
        return { ...p, unread: 0, lastReadAt: new Date() };
      }
      return p;
    });
    await chat.save();

    // Tell the other side our read pointer moved (so their "sent" → "read"
    // hint can update without polling).
    for (const p of (chat as any).participants) {
      if (String(p.user) === meId) continue;
      emitToUser(String(p.user), "chat:read", {
        chatId: String(chat._id),
        by: meId,
        at: new Date(),
      });
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ message: "Failed to mark read" });
  }
});

export default router;
