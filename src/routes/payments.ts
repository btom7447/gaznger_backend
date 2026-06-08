import { Router } from "express";
import crypto from "crypto";
import { v4 as uuidv4 } from "uuid";
import Order from "../models/Order";
import User from "../models/User";
import WebhookEvent from "../models/WebhookEvent";
import { requireAuth } from "../middleware/auth";
import { idempotencyKey } from "../middleware/idempotency";
import { moneyLimiter } from "../middleware/moneyLimiter";
import { emitPaymentFailed } from "../utils/alertEvents";
import {
  initializePayment,
  verifyPayment,
  chargeAuthorization,
  paystackSecret,
  paystackPublicKey,
  PaystackAuthorization,
} from "../utils/paystack";
import { notifyUser } from "../utils/notify";
import { emitToUser, emitToAdmins } from "../socket";
import {
  getOrCreateUserWallet,
  getOrCreateSystemWallet,
  postSingle,
  postTransfer,
  findByIdempotencyKey,
} from "../utils/wallet";
import { getPlatformConfig } from "../utils/platformConfig";

const router = Router();

/* ─────────────────────────── helpers ───────────────────────────── */

/**
 * Email Paystack records on the transaction. Use the user's real
 * address when set, otherwise an opaque per-user identifier — never
 * derive from `user.phone` (audit F.3): the phone number is PII we
 * don't want sitting in a third-party's logs/console under a "user
 * email" label, and Paystack's dashboard exposes it to anyone with
 * staff access.
 */
function paystackEmailFor(user: { email?: string | null; _id: unknown }): string {
  if (user.email) return user.email;
  const id = (user._id as { toString(): string }).toString();
  return `${id}@users.gaznger.app`;
}

/** Persist Paystack's `authorization` block on the customer's User doc. */
async function saveCardOnUser(userId: string, auth?: PaystackAuthorization) {
  if (!auth || !auth.authorization_code || !auth.last4 || !auth.reusable) return;
  await User.updateOne(
    { _id: userId },
    {
      $set: {
        lastPaystackAuth: {
          authorizationCode: auth.authorization_code,
          last4: auth.last4,
          brand: auth.brand,
          bank: auth.bank,
          expMonth: auth.exp_month,
          expYear: auth.exp_year,
          cardType: auth.card_type,
          signature: auth.signature,
        },
      },
    }
  );
}

/**
 * Mark an order paid + post the customer-charge ledger leg(s):
 *   Paystack → platform-escrow.pending  (single credit on escrow)
 *
 * The matching customer-side debit doesn't exist as a real wallet —
 * the money came from outside the system. We use one synthetic single
 * row; the offset is implicit in `paystackRef`.
 *
 * Idempotency: keyed on `paystackRef:order_charge` so a verify retry
 * after webhook (or vice-versa) doesn't double-credit escrow.
 */
async function postOrderChargeToEscrow(args: {
  orderId: string;
  customerId: string;
  amount: number;
  paystackRef: string;
  paystackEventId?: string;
}) {
  const { orderId, customerId, amount, paystackRef, paystackEventId } = args;
  const escrow = await getOrCreateSystemWallet("platform-escrow");
  const idempotencyKey = `paystack:${paystackRef}:order_charge`;

  // Short-circuit if we've already booked this charge.
  const prior = await findByIdempotencyKey(idempotencyKey);
  if (prior.length > 0) return prior[0];

  return postSingle({
    wallet: escrow,
    amount,
    state: "pending",
    kind: "order_charge_credit",
    opts: {
      idempotencyKey,
      description: `Order charge ${paystackRef}`,
      order: orderId as any,
      paystackRef,
      paystackEventId,
      meta: { customerId },
    },
  });
}

/* ─────────────────────────── INITIALIZE ────────────────────────── */

/**
 * POST /api/payments/initialize
 * Body: { orderId }
 * Returns: { authorizationUrl, reference, publicKey }
 *
 * Stays as the entry point for first-time-card and bank-transfer flows
 * (the Paystack webview / hosted page handles the actual collection).
 */
router.post("/initialize", requireAuth, moneyLimiter, idempotencyKey(), async (req, res) => {
  try {
    const cfg = await getPlatformConfig();
    if (!cfg.paymentsEnabled)
      return res.status(503).json({ message: "Payments are temporarily disabled" });

    const { orderId } = req.body;
    if (!orderId) return res.status(400).json({ message: "orderId is required" });

    const order = await Order.findById(orderId);
    if (!order) return res.status(404).json({ message: "Order not found" });
    if (order.user.toString() !== req.userId)
      return res.status(403).json({ message: "Forbidden" });
    if (order.paymentStatus === "paid")
      return res.status(400).json({ message: "Order already paid" });
    if (order.totalPrice < cfg.minChargeNgn)
      return res.status(400).json({
        message: `Minimum charge is ₦${cfg.minChargeNgn.toLocaleString()}`,
      });

    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ message: "User not found" });

    const reference = `GAZ-${uuidv4().replace(/-/g, "").slice(0, 16).toUpperCase()}`;
    const amountKobo = Math.round(order.totalPrice * 100);

    const paymentData = await initializePayment({
      email: paystackEmailFor(user),
      amount: amountKobo,
      reference,
      metadata: { orderId: order._id.toString(), kind: "order_charge" },
    });

    order.paymentRef = reference;
    await order.save();

    res.json({
      authorizationUrl: paymentData.authorization_url,
      reference: paymentData.reference,
      publicKey: paystackPublicKey(),
    });
  } catch (err) {
    console.error("[payments/initialize]", err);
    res.status(500).json({ message: "Failed to initialize payment" });
  }
});

/* ─────────────────────────── VERIFY ────────────────────────────── */

/**
 * POST /api/payments/verify
 * Body: { reference }
 *
 * Customer-driven verification (also called by the mobile SDK on close).
 * Idempotent — if the webhook beat us here, the ledger short-circuits.
 */
router.post("/verify", requireAuth, moneyLimiter, idempotencyKey(), async (req, res) => {
  try {
    const { reference } = req.body;
    if (!reference) return res.status(400).json({ message: "reference is required" });

    const data = await verifyPayment(reference);
    if (data.status !== "success")
      return res.status(400).json({ message: "Payment not successful" });

    const order = await Order.findOne({ paymentRef: reference });
    if (!order) return res.status(404).json({ message: "Order not found" });
    if (order.user.toString() !== req.userId)
      return res.status(403).json({ message: "Forbidden" });

    // Ledger first — it's idempotent. Order flag flip is fine to repeat.
    await postOrderChargeToEscrow({
      orderId: order._id.toString(),
      customerId: order.user.toString(),
      amount: order.totalPrice,
      paystackRef: reference,
    });
    await saveCardOnUser(order.user.toString(), data.authorization);

    // SEC-P2 (audit run 6): atomic flip. Pre-fix this and the webhook
    // charge.success handler both did `if !== "paid" { ... save() }`;
    // concurrent /verify + webhook both passed the guard and fired
    // two "Payment Successful" pushes. findOneAndUpdate with a
    // guard-in-filter resolves the race — only one writer wins, the
    // loser sees `flipped == null` and skips the side effects.
    const flipped = await Order.findOneAndUpdate(
      { _id: order._id, paymentStatus: { $ne: "paid" } },
      { $set: { paymentStatus: "paid", status: "confirmed" } },
      { new: true },
    );
    if (flipped) {
      order.paymentStatus = flipped.paymentStatus;
      order.status = flipped.status;
      await notifyUser(
        req.userId!,
        "payment",
        "Payment Successful",
        `Your payment of ₦${order.totalPrice.toLocaleString()} was received. Your order is being processed.`
      );
    }

    emitToUser(req.userId!, "order:update", {
      orderId: order._id.toString(),
      status: order.status,
      paymentStatus: order.paymentStatus,
    });

    res.json({ message: "Payment verified", order });
  } catch (err) {
    console.error("[payments/verify]", err);
    res.status(500).json({ message: "Failed to verify payment" });
  }
});

/* ─────────────────────── CHARGE SAVED CARD ─────────────────────── */

/**
 * POST /api/payments/charge-saved
 * Body: { orderId }
 *
 * Charges the user's saved authorization (no webview). Falls back to
 * "no saved card" 400 so the client knows to call /initialize instead.
 */
router.post("/charge-saved", requireAuth, moneyLimiter, idempotencyKey({ enforce: true }), async (req, res) => {
  try {
    const cfg = await getPlatformConfig();
    if (!cfg.paymentsEnabled)
      return res.status(503).json({ message: "Payments are temporarily disabled" });

    const { orderId } = req.body;
    if (!orderId) return res.status(400).json({ message: "orderId is required" });

    const order = await Order.findById(orderId);
    if (!order) return res.status(404).json({ message: "Order not found" });
    if (order.user.toString() !== req.userId)
      return res.status(403).json({ message: "Forbidden" });
    if (order.paymentStatus === "paid")
      return res.status(400).json({ message: "Order already paid" });

    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ message: "User not found" });
    if (!user.lastPaystackAuth?.authorizationCode)
      return res.status(400).json({ message: "No saved card. Use the new-card flow." });

    const reference = `GAZ-${uuidv4().replace(/-/g, "").slice(0, 16).toUpperCase()}`;
    const amountKobo = Math.round(order.totalPrice * 100);

    const data = await chargeAuthorization({
      authorization_code: user.lastPaystackAuth.authorizationCode,
      email: paystackEmailFor(user),
      amount: amountKobo,
      reference,
      metadata: { orderId: order._id.toString(), kind: "order_charge_saved" },
    });
    if (data.status !== "success")
      return res.status(402).json({ message: "Saved-card charge declined" });

    order.paymentRef = reference;
    order.paymentStatus = "paid";
    order.status = "confirmed";
    await order.save();

    await postOrderChargeToEscrow({
      orderId: order._id.toString(),
      customerId: order.user.toString(),
      amount: order.totalPrice,
      paystackRef: reference,
    });
    await saveCardOnUser(order.user.toString(), data.authorization);

    await notifyUser(
      req.userId!,
      "payment",
      "Payment Successful",
      `Charged your card ending ${user.lastPaystackAuth.last4} — ₦${order.totalPrice.toLocaleString()}.`
    );
    emitToUser(req.userId!, "order:update", {
      orderId: order._id.toString(),
      status: order.status,
      paymentStatus: order.paymentStatus,
    });

    res.json({ message: "Payment successful", order, reference });
  } catch (err: any) {
    console.error("[payments/charge-saved]", err?.response?.data ?? err);
    res.status(500).json({ message: "Failed to charge saved card" });
  }
});

/* ─────────────────────── PAY WITH WALLET ───────────────────────── */

/**
 * POST /api/payments/pay-with-wallet
 * Body: { orderId }
 *
 * Spend customer wallet balance directly. Two-leg ledger:
 *   customer.available  →  platform-escrow.pending
 *
 * Insufficient → 402 with the shortfall.
 */
router.post("/pay-with-wallet", requireAuth, moneyLimiter, idempotencyKey({ enforce: true }), async (req, res) => {
  try {
    const cfg = await getPlatformConfig();
    if (!cfg.paymentsEnabled)
      return res.status(503).json({ message: "Payments are temporarily disabled" });

    const { orderId } = req.body;
    if (!orderId) return res.status(400).json({ message: "orderId is required" });

    const order = await Order.findById(orderId);
    if (!order) return res.status(404).json({ message: "Order not found" });
    if (order.user.toString() !== req.userId)
      return res.status(403).json({ message: "Forbidden" });
    if (order.paymentStatus === "paid")
      return res.status(400).json({ message: "Order already paid" });

    const wallet = await getOrCreateUserWallet(req.userId!);
    if (wallet.available < order.totalPrice) {
      return res.status(402).json({
        message: "Insufficient wallet balance",
        shortfall: order.totalPrice - wallet.available,
      });
    }

    const escrow = await getOrCreateSystemWallet("platform-escrow");
    const idempotencyKey = `wallet-pay:${order._id.toString()}`;

    const reference = `GAZ-WLT-${uuidv4().replace(/-/g, "").slice(0, 12).toUpperCase()}`;

    await postTransfer({
      from: wallet,
      to: escrow,
      amount: order.totalPrice,
      state: "available", // debit available; lands in escrow.available …
      kinds: ["order_wallet_debit", "order_charge_credit"],
      description: `Pay order ${order._id.toString().slice(-6).toUpperCase()} with wallet`,
      opts: {
        idempotencyKey,
        order: order._id as any,
        paystackRef: reference,
        meta: { method: "wallet" },
      },
    });

    // …then shift escrow.available → escrow.pending so it stays in the
    // hold bucket like card-charged orders. We do this via a single-leg
    // pair to keep the bucket-shift atomic-ish under the same groupId.
    // (Belt-and-braces: a separate idempotency key derivative.)
    await postSingle({
      wallet: escrow,
      amount: -order.totalPrice,
      state: "available",
      kind: "order_wallet_debit",
      opts: {
        idempotencyKey: `${idempotencyKey}:escrow-out`,
        description: "Move wallet-paid funds into escrow.pending",
        order: order._id as any,
      },
    });
    await postSingle({
      wallet: escrow,
      amount: order.totalPrice,
      state: "pending",
      kind: "order_charge_credit",
      opts: {
        idempotencyKey: `${idempotencyKey}:escrow-in`,
        description: "Wallet-paid funds held in escrow",
        order: order._id as any,
      },
    });

    order.paymentRef = reference;
    order.paymentStatus = "paid";
    order.status = "confirmed";
    await order.save();

    await notifyUser(
      req.userId!,
      "payment",
      "Paid with wallet",
      `Charged ₦${order.totalPrice.toLocaleString()} from your Gaznger wallet.`
    );
    const fresh = await getOrCreateUserWallet(req.userId!);
    emitToUser(req.userId!, "wallet:update", {
      available: fresh.available,
      pending: fresh.pending,
    });
    emitToUser(req.userId!, "order:update", {
      orderId: order._id.toString(),
      status: order.status,
      paymentStatus: order.paymentStatus,
    });

    res.json({ message: "Paid with wallet", order, reference });
  } catch (err) {
    console.error("[payments/pay-with-wallet]", err);
    res.status(500).json({ message: "Failed to pay with wallet" });
  }
});

/* ─────────────────────── WALLET TOP-UP ─────────────────────────── */

/**
 * POST /api/payments/topup/initialize
 * Body: { amount }   (NGN whole)
 *
 * Initializes a Paystack charge for wallet credit. The verify path
 * (below) detects the kind via metadata and credits wallet.available
 * instead of escrow.
 */
router.post("/topup/initialize", requireAuth, moneyLimiter, idempotencyKey(), async (req, res) => {
  try {
    const cfg = await getPlatformConfig();
    if (!cfg.paymentsEnabled)
      return res.status(503).json({ message: "Payments are temporarily disabled" });

    const amountNum = Number(req.body?.amount);
    if (!Number.isFinite(amountNum) || amountNum <= 0)
      return res.status(400).json({ message: "amount must be a positive number" });
    if (amountNum < cfg.minChargeNgn)
      return res.status(400).json({
        message: `Minimum top-up is ₦${cfg.minChargeNgn.toLocaleString()}`,
      });
    // SEC-P2 (audit run 6): upper cap on top-up amount. Without this
    // a hostile/buggy client could initialize a Paystack charge for an
    // absurd amount and credit the wallet on verify. Optional-chained
    // off PlatformConfig so admins can raise the ceiling without a
    // schema migration; defaults to ₦500,000.
    const maxTopup = (cfg as any).maxTopupNgn ?? 500_000;
    if (amountNum > maxTopup)
      return res.status(400).json({
        message: `Maximum top-up is ₦${maxTopup.toLocaleString()}`,
      });

    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ message: "User not found" });

    const reference = `GAZ-TUP-${uuidv4().replace(/-/g, "").slice(0, 12).toUpperCase()}`;
    const amountKobo = Math.round(amountNum * 100);

    const paymentData = await initializePayment({
      email: paystackEmailFor(user),
      amount: amountKobo,
      reference,
      metadata: { kind: "wallet_topup", userId: user._id.toString(), amountNgn: amountNum },
    });

    res.json({
      authorizationUrl: paymentData.authorization_url,
      reference: paymentData.reference,
      publicKey: paystackPublicKey(),
    });
  } catch (err) {
    console.error("[payments/topup/initialize]", err);
    res.status(500).json({ message: "Failed to initialize top-up" });
  }
});

/**
 * POST /api/payments/topup/verify
 * Body: { reference }
 *
 * Verifies a top-up Paystack transaction and credits wallet.available.
 * Idempotent on `paystackRef:topup`.
 */
router.post("/topup/verify", requireAuth, moneyLimiter, idempotencyKey(), async (req, res) => {
  try {
    const { reference } = req.body;
    if (!reference) return res.status(400).json({ message: "reference is required" });

    const data = await verifyPayment(reference);
    if (data.status !== "success")
      return res.status(400).json({ message: "Payment not successful" });

    const meta = data.metadata ?? {};
    if (meta.kind !== "wallet_topup")
      return res.status(400).json({ message: "Reference is not a wallet top-up" });

    if (meta.userId && meta.userId !== req.userId)
      return res.status(403).json({ message: "Forbidden" });

    const amountNgn = Number(meta.amountNgn ?? data.amount / 100);
    const wallet = await getOrCreateUserWallet(req.userId!);

    await postSingle({
      wallet,
      amount: amountNgn,
      state: "available",
      kind: "topup_credit",
      opts: {
        idempotencyKey: `paystack:${reference}:topup`,
        description: `Wallet top-up ${reference}`,
        paystackRef: reference,
      },
    });

    await saveCardOnUser(req.userId!, data.authorization);

    const fresh = await getOrCreateUserWallet(req.userId!);
    emitToUser(req.userId!, "wallet:update", {
      available: fresh.available,
      pending: fresh.pending,
    });

    res.json({
      message: "Top-up successful",
      available: fresh.available,
      pending: fresh.pending,
    });
  } catch (err) {
    console.error("[payments/topup/verify]", err);
    res.status(500).json({ message: "Failed to verify top-up" });
  }
});

/* ─────────────────────────── WEBHOOK ───────────────────────────── */

/**
 * POST /api/payments/webhook
 *
 * Hardened version:
 *   - HMAC-SHA512 verification (matches active secret)
 *   - Logs every event to WebhookEvent (unique on eventId — replay safe)
 *   - Dispatches by event name; ledger writes are idempotent
 */
router.post("/webhook", async (req, res) => {
  try {
    const signature = req.headers["x-paystack-signature"] as string;
    const secret = paystackSecret();
    const rawBody = req.body as Buffer;

    const hash = crypto
      .createHmac("sha512", secret)
      .update(rawBody)
      .digest("hex");
    // SEC-P1 (audit run 5): non-constant-time string `!==` short-
    // circuits on the first mismatching byte, letting an attacker
    // use response-latency to reconstruct the expected HMAC byte by
    // byte (forge `charge.success` events for arbitrary wallet
    // credits). crypto.timingSafeEqual requires both buffers to be
    // the same length — guard that explicitly so a malformed header
    // doesn't crash with a RangeError.
    if (!signature || typeof signature !== "string") {
      return res.status(401).json({ message: "Missing signature" });
    }
    const hashBuf = Buffer.from(hash, "hex");
    let sigBuf: Buffer;
    try {
      sigBuf = Buffer.from(signature, "hex");
    } catch {
      return res.status(401).json({ message: "Invalid signature" });
    }
    if (
      hashBuf.length !== sigBuf.length ||
      !crypto.timingSafeEqual(hashBuf, sigBuf)
    ) {
      return res.status(401).json({ message: "Invalid signature" });
    }

    const payload = JSON.parse(rawBody.toString());
    const { event, data } = payload;
    // SEC-P2 (audit run 5): pre-fix the eventId fallback minted a
    // fresh uuidv4() when both data.id and data.reference were
    // missing — broke the WebhookEvent {source,eventId} unique-index
    // dedup so every replay re-fired notifyUser + emitToUser.
    // Money side was safe (Transaction-level keys are stable) but
    // duplicate notifications could spam users. Use sha256 of the
    // raw body as the dedup key when no stable id is present.
    const eventId =
      data?.id?.toString() ??
      (data?.reference
        ? `${event}:${data.reference}`
        : `${event}:sha256:${crypto.createHash("sha256").update(rawBody).digest("hex").slice(0, 32)}`);

    // Insert log row first; unique index dedupes redeliveries.
    let logEntry;
    try {
      logEntry = await WebhookEvent.create({
        source: "paystack",
        eventId,
        event,
        payload,
        signature,
      });
    } catch (err: any) {
      if (err?.code === 11000) {
        // Already processed — ack and move on.
        return res.sendStatus(200);
      }
      throw err;
    }

    try {
      if (event === "charge.success") {
        const ref = data.reference as string;
        const meta = data.metadata ?? {};

        if (meta.kind === "wallet_topup") {
          // Top-up via webhook (e.g. user closed app before /topup/verify).
          const userId = meta.userId as string | undefined;
          const amountNgn = Number(meta.amountNgn ?? data.amount / 100);
          if (userId) {
            const wallet = await getOrCreateUserWallet(userId);
            await postSingle({
              wallet,
              amount: amountNgn,
              state: "available",
              kind: "topup_credit",
              opts: {
                idempotencyKey: `paystack:${ref}:topup`,
                description: `Wallet top-up ${ref}`,
                paystackRef: ref,
                paystackEventId: eventId,
              },
            });
            await saveCardOnUser(userId, data.authorization);
            const fresh = await getOrCreateUserWallet(userId);
            emitToUser(userId, "wallet:update", {
              available: fresh.available,
              pending: fresh.pending,
            });
          }
        } else {
          // Order charge.
          const order = await Order.findOne({ paymentRef: ref });
          if (order) {
            await postOrderChargeToEscrow({
              orderId: order._id.toString(),
              customerId: order.user.toString(),
              amount: order.totalPrice,
              paystackRef: ref,
              paystackEventId: eventId,
            });
            await saveCardOnUser(order.user.toString(), data.authorization);

            // SEC-P2 (audit run 6): atomic flip — see the verify
            // handler above for the rationale. Without this, a
            // concurrent /verify + webhook both fire the push.
            const flipped = await Order.findOneAndUpdate(
              { _id: order._id, paymentStatus: { $ne: "paid" } },
              { $set: { paymentStatus: "paid", status: "confirmed" } },
              { new: true },
            );
            if (flipped) {
              await notifyUser(
                order.user.toString(),
                "payment",
                "Payment Confirmed",
                `Your payment for order #${order._id.toString().slice(-6).toUpperCase()} was successful.`
              );
              emitToUser(order.user.toString(), "order:update", {
                orderId: order._id.toString(),
                status: flipped.status,
                paymentStatus: flipped.paymentStatus,
              });
            }
          }
        }
      }

      if (event === "refund.processed") {
        // Paystack confirms a card refund landed back on the customer's
        // card. The admin/refund endpoint already flipped the order to
        // "refunded" optimistically — this is just the finalizer.
        const ref =
          (data?.transaction?.reference as string | undefined) ??
          (data?.transaction_reference as string | undefined);
        if (ref) {
          const order = await Order.findOne({ paymentRef: ref });
          if (order) {
            await notifyUser(
              order.user.toString(),
              "payment",
              "Refund Completed",
              `Your refund for order #${order._id.toString().slice(-6).toUpperCase()} has landed on your card.`
            );
            emitToUser(order.user.toString(), "order:update", {
              orderId: order._id.toString(),
              status: order.status,
              paymentStatus: order.paymentStatus,
              refundProcessed: true,
            });
          }
        }
      }

      if (event === "refund.failed") {
        // Paystack couldn't return the funds to the card. Move the
        // refund into the customer's wallet as a fallback.
        const ref =
          (data?.transaction?.reference as string | undefined) ??
          (data?.transaction_reference as string | undefined);
        if (ref) {
          const order = await Order.findOne({ paymentRef: ref });
          if (order && order.paymentStatus === "refunded") {
            const { refundOrderToWallet } = await import("../utils/earningsUtils");
            await refundOrderToWallet({
              orderId: order._id.toString(),
              amount: order.totalPrice,
              reason: "Card refund failed — credited to wallet instead",
            });
            await notifyUser(
              order.user.toString(),
              "payment",
              "Refund Credited to Wallet",
              `We couldn't refund your card so we credited ₦${order.totalPrice.toLocaleString()} to your Gaznger wallet.`
            );
          }
        }
      }

      if (event === "transfer.success") {
        // Paystack confirms our payout reached the bank.
        const transferCode = data.transfer_code as string | undefined;
        if (transferCode) {
          const Withdrawal = (await import("../models/Withdrawal")).default;
          await Withdrawal.updateOne(
            { paystackTransferCode: transferCode, status: { $ne: "approved" } },
            { status: "approved", processedAt: new Date() }
          );
          // Notify the user.
          const w = await Withdrawal.findOne({ paystackTransferCode: transferCode }).lean();
          if (w) {
            await notifyUser(
              w.user.toString(),
              "payment",
              "Withdrawal Successful",
              `₦${w.amount.toLocaleString()} has been transferred to your bank.`
            );
            emitToUser(w.user.toString(), "withdrawal:update", {
              withdrawalId: w._id,
              status: "approved",
            });
            // P1-3: admin dashboard should reflect transfer success.
            emitToAdmins("withdrawal:update", {
              withdrawalId: String(w._id),
              status: "approved",
              userId: String(w.user),
            });
          }
        }
      }

      if (event === "transfer.failed" || event === "transfer.reversed") {
        // Paystack tells us the transfer didn't land. Reverse the wallet
        // debit so the user gets their money back.
        const transferCode = data.transfer_code as string | undefined;
        if (transferCode) {
          const Withdrawal = (await import("../models/Withdrawal")).default;
          const w = await Withdrawal.findOne({
            paystackTransferCode: transferCode,
          });
          if (w && w.status !== "failed") {
            const { getOrCreateUserWallet, getOrCreateSystemWallet, postTransfer } =
              await import("../utils/wallet");
            const userWallet = await getOrCreateUserWallet(w.user);
            const platformRevenue = await getOrCreateSystemWallet("platform-revenue");
            await postTransfer({
              from: platformRevenue,
              to: userWallet,
              amount: w.amount,
              state: "available",
              kinds: ["platform_commission_credit", "withdraw_reversal_credit"],
              description: `Webhook reversal for failed transfer ${transferCode}`,
              opts: {
                idempotencyKey: `withdrawal:${w._id}:webhook-reverse`,
                withdrawal: w._id as any,
                paystackTransferCode: transferCode,
                paystackEventId: eventId,
              },
            });
            w.status = "failed";
            w.processedAt = new Date();
            w.note = `Paystack ${event}`;
            await w.save();

            const fresh = await getOrCreateUserWallet(w.user);
            emitToUser(w.user.toString(), "wallet:update", {
              available: fresh.available,
              pending: fresh.pending,
            });
            emitToUser(w.user.toString(), "withdrawal:update", {
              withdrawalId: w._id,
              status: "failed",
            });
            // P1-3: critical ops event — withdrawal failed in prod.
            // Ops dashboard renders a red banner; admin can intervene.
            emitToAdmins("withdrawal:failed", {
              withdrawalId: String(w._id),
              userId: String(w.user),
              amount: w.amount,
              event,
              transferCode,
            });
            // WS_VS_API #3 — explicit payment:failed for the toast +
            // any UI that wants to react beyond the generic wallet
            // refresh.
            emitPaymentFailed(w.user.toString(), {
              reason: `Paystack ${event}`,
              amount: w.amount,
            });
            await notifyUser(
              w.user.toString(),
              "payment",
              "Withdrawal Failed",
              `Your ₦${w.amount.toLocaleString()} payout couldn't be completed. The funds are back in your wallet.`
            );
          }
        }
      }

      logEntry.processedAt = new Date();
      await logEntry.save();
    } catch (err: any) {
      logEntry.error = err?.message ?? String(err);
      await logEntry.save();
      // Still 200 — Paystack should not redeliver; we'll fix and replay manually.
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("[payments/webhook]", err);
    res.sendStatus(500);
  }
});

/* ─────────────── DEV: mark order paid (no Paystack hit) ─────────────── */
/**
 * EDGE P0-4 — closes the dev-only "bank-transfer Continue" loophole
 * where the customer mobile shortcut at
 * `app/(customer)/(order)/payment.tsx:437-457` jumped to the receipt
 * without telling the server the order was paid. The result was
 * customers in dev landing on a receipt for an UNPAID order.
 *
 * This endpoint flips the order to `paid` + `confirmed` exactly the
 * way a real Paystack verify would, but without a Paystack roundtrip
 * — it's the missing server half of the dev shortcut. Hard-gated to
 * non-production; refuses to run in prod under any flag combination.
 *
 * Mobile counterpart (Phase 1B) calls this immediately after the dev
 * Continue tap so the order state stays consistent.
 */
router.post(
  "/dev-mark-paid",
  requireAuth,
  moneyLimiter,
  idempotencyKey(),
  async (req, res) => {
    if (process.env.NODE_ENV === "production") {
      return res.status(404).json({ message: "Not found" });
    }
    try {
      const { orderId } = req.body as { orderId?: string };
      if (!orderId) {
        return res.status(400).json({ message: "orderId required" });
      }
      const order = await Order.findOne({ _id: orderId, user: req.userId });
      if (!order) {
        return res.status(404).json({ message: "Order not found" });
      }
      if (order.paymentStatus === "paid") {
        return res.json({ order, alreadyPaid: true });
      }
      order.paymentStatus = "paid";
      order.paymentRef = `dev-mark-paid:${Date.now()}`;
      if (order.status === "pending") {
        order.status = "confirmed";
      }
      await order.save();

      emitToUser(req.userId, "order:update", {
        orderId: String(order._id),
        status: order.status,
        paymentStatus: order.paymentStatus,
      });

      res.json({ order });
    } catch (err) {
      console.error("[payments/dev-mark-paid]", err);
      res.status(500).json({ message: "Failed to mark paid" });
    }
  },
);


export default router;
