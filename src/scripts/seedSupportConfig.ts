/**
 * One-shot seed: fill PlatformConfig.support with role-scoped phone /
 * email / FAQ blocks so the mobile help-support screen has real
 * values before the admin web edit page lands.
 *
 * Run from /server:
 *   npx ts-node src/scripts/seedSupportConfig.ts
 *
 * Idempotent — re-running overwrites the support block with the values
 * below. Refuses to run against a prod URI without SEED_FORCE=1.
 */
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import mongoose from "mongoose";
import PlatformConfig from "../models/PlatformConfig";
import { invalidatePlatformConfig } from "../utils/platformConfig";

const SHARED_EMAIL = "support@gaznger.com";

const SUPPORT_BLOCKS = {
  customer: {
    phone: "+2348004296437",
    email: SHARED_EMAIL,
    hours: "Mon–Sun · 7am – 11pm",
    liveChatEnabled: true,
    faqs: [
      {
        q: "How do I place a fuel order?",
        a: "Tap a fuel on the home screen, set the quantity and delivery address, pick a station, then pay. We'll match you with the closest rider in under a minute.",
      },
      {
        q: "How long does delivery take?",
        a: "Typical delivery is 30–60 minutes depending on traffic and station distance. The Track screen shows a live ETA the moment a rider is matched.",
      },
      {
        q: "Can I cancel an order?",
        a: "Yes — open the order from Order History and tap Cancel. Cancellation is free until a rider picks up your fuel from the station.",
      },
      {
        q: "How do Gaznger Points work?",
        a: "You earn 50–200 points per delivered order. 1 point = ₦1 off any future order. Apply them on the Payment screen, or flip on Auto-redeem in Settings.",
      },
      {
        q: "What payment methods are accepted?",
        a: "Cards (saved or one-off via Paystack), the Gaznger wallet, and bank transfer. Cash on delivery isn't supported — every order needs an audit trail.",
      },
      {
        q: "Why is my wallet balance pending?",
        a: "Top-ups settle instantly. Refunds and earnings sit in pending until the order closes (delivery confirmed + 24-hour dispute window).",
      },
    ],
  },
  vendor: {
    phone: "+2348004296438",
    email: SHARED_EMAIL,
    hours: "Mon–Sat · 6am – 10pm",
    liveChatEnabled: true,
    faqs: [
      {
        q: "How do I add a station?",
        a: "Profile → Stations → Add station. Fill in address, fuels, prices, and operating hours. New stations are reviewed before they go live.",
      },
      {
        q: "How do payouts work?",
        a: "Settled wallet balance lands in your linked bank within 60 seconds of a withdrawal request. Daily auto-payouts run at 06:00 if enabled.",
      },
      {
        q: "How do I invite a rider?",
        a: "Team → Invite rider. Pick the station first, then enter the rider's phone number. They're bound to that station once they sign up. Reassign from the rider's profile.",
      },
      {
        q: "Why is my order escrowed?",
        a: "Funds sit in escrow from order placement until the rider confirms delivery + the 24-hour dispute window closes. After that they release to your wallet.",
      },
      {
        q: "How do I update fuel prices?",
        a: "Profile → Stations → Edit station → Fuels & prices. Changes propagate to live carts older than 30 seconds via the station:update socket.",
      },
      {
        q: "What if a bulk purchase has a variance?",
        a: "Open the supply in the Supplies tab → Reconcile. Variance ≤ 0.5% closes automatically. Above that, dispute opens a thread with the plant.",
      },
    ],
  },
  rider: {
    phone: "+2348004296439",
    email: SHARED_EMAIL,
    hours: "24/7",
    liveChatEnabled: true,
    faqs: [
      {
        q: "How are orders assigned to me?",
        a: "We match riders to nearby orders based on station proximity and your current location. Going online makes you eligible for dispatch.",
      },
      {
        q: "When do I get paid?",
        a: "Earnings settle on order delivery + the 24-hour dispute window. Withdraw any time from the Wallet screen.",
      },
      {
        q: "How do I update my vehicle details?",
        a: "Profile → Vehicle. Plate, brand, color, and papers can all be edited — papers may trigger a re-verification.",
      },
      {
        q: "What if a customer isn't available?",
        a: "Wait 5 minutes at the dropoff, try calling them, then mark \"Customer not available\" on the order. We'll handle the refund/retry from there.",
      },
      {
        q: "Why can't I see new orders?",
        a: "Check you're online, your location services are on, and you're inside your home station's dispatch radius. If you have an active order, you won't see new ones until you complete it.",
      },
    ],
  },
};

async function run() {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI missing from .env.local");
  if (/prod|production/i.test(uri) && process.env.SEED_FORCE !== "1") {
    throw new Error(
      "Refusing to run against a prod URI without SEED_FORCE=1",
    );
  }

  await mongoose.connect(uri, { serverSelectionTimeoutMS: 8000 });
  console.log("Connected:", mongoose.connection.host);
  console.log("Database:", mongoose.connection.name);

  // upsert pattern — touches only the .support subtree so other
  // config (commissions, kill-switches, etc.) stays untouched.
  const result = await PlatformConfig.findOneAndUpdate(
    { key: "main" },
    {
      $set: {
        "support.customer": SUPPORT_BLOCKS.customer,
        "support.vendor": SUPPORT_BLOCKS.vendor,
        "support.rider": SUPPORT_BLOCKS.rider,
      },
      $setOnInsert: { key: "main" },
    },
    { new: true, upsert: true },
  );

  console.log("");
  console.log("=== Support seeded ===");
  for (const role of ["customer", "vendor", "rider"] as const) {
    const block = (result as any).support?.[role];
    console.log(
      `  ${role.padEnd(8)} → ${block?.phone ?? "—"} · ${block?.email ?? "—"} · ${block?.faqs?.length ?? 0} FAQs`,
    );
  }

  // Bust the 60s cache so the next /support-info call sees the new
  // values immediately.
  invalidatePlatformConfig();

  await mongoose.disconnect();
  console.log("Done.");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
