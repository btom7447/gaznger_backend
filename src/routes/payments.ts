import { Router } from "express";
import crypto from "crypto";
import { v4 as uuidv4 } from "uuid";
import Order from "../models/Order";
import User from "../models/User";
import Notification from "../models/Notification";
import { requireAuth } from "../middleware/auth";
import { initializePayment, verifyPayment } from "../utils/paystack";
import { sendPushNotification } from "../utils/push";

const router = Router();

// ===================== INITIALIZE PAYMENT =====================
router.post("/initialize", requireAuth, async (req, res) => {
  try {
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

    const reference = `GAZ-${uuidv4().replace(/-/g, "").slice(0, 16).toUpperCase()}`;
    const amountKobo = Math.round(order.totalPrice * 100);

    const paymentData = await initializePayment({
      email: user.email,
      amount: amountKobo,
      reference,
      metadata: { orderId: order._id.toString() },
    });

    order.paymentRef = reference;
    await order.save();

    res.json({
      authorizationUrl: paymentData.authorization_url,
      reference: paymentData.reference,
    });
  } catch (err) {
    res.status(500).json({ message: "Failed to initialize payment" });
  }
});

// ===================== VERIFY PAYMENT =====================
router.post("/verify", requireAuth, async (req, res) => {
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

    order.paymentStatus = "paid";
    order.status = "confirmed";
    await order.save();

    res.json({ message: "Payment verified", order });
  } catch (err) {
    res.status(500).json({ message: "Failed to verify payment" });
  }
});

// ===================== PAYSTACK WEBHOOK =====================
// Note: raw body is captured in app.ts before express.json() for this route
router.post("/webhook", async (req, res) => {
  try {
    const signature = req.headers["x-paystack-signature"] as string;
    const secret = process.env.PAYSTACK_SECRET_KEY!;

    const rawBody = req.body; // Buffer (from express.raw middleware in app.ts)
    const hash = crypto
      .createHmac("sha512", secret)
      .update(rawBody)
      .digest("hex");

    if (hash !== signature)
      return res.status(401).json({ message: "Invalid signature" });

    const payload = JSON.parse(rawBody.toString());
    const { event, data } = payload;

    if (event === "charge.success") {
      const order = await Order.findOne({ paymentRef: data.reference });
      if (order && order.paymentStatus !== "paid") {
        order.paymentStatus = "paid";
        order.status = "confirmed";
        await order.save();

        const user = await User.findById(order.user);
        if (user) {
          await Notification.create({
            user: user._id,
            type: "order",
            title: "Payment Confirmed",
            body: `Your payment for order #${order._id.toString().slice(-6).toUpperCase()} was successful. Your order is being processed.`,
          });

          if (user.deviceTokens.length > 0) {
            await sendPushNotification(
              user.deviceTokens,
              "Payment Confirmed",
              "Your order is being processed."
            );
          }
        }
      }
    }

    res.sendStatus(200);
  } catch (err) {
    res.sendStatus(500);
  }
});

export default router;
