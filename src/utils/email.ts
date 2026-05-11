import { Resend } from "resend";

/**
 * Resend wrapper for transactional email.
 *
 * Every email purpose has its own sender identity so customers can:
 *   - Tell at a glance what kind of mail they're getting (auth vs receipt
 *     vs alert)
 *   - Reply to the right inbox (support@ goes to humans; no-reply@ goes
 *     nowhere)
 *   - Apply per-purpose filtering / spam rules without losing legit mail
 *
 * `EMAIL_DOMAIN` defaults to `gaznger.com`. Override per-environment via
 * env var if a different sending domain is verified in Resend (e.g.
 * `staging.gaznger.com`).
 *
 * Construction is lazy: the Resend SDK throws at `new Resend("")` and
 * we want the server to boot even when RESEND_API_KEY is unset (early
 * Railway deploys). When unset, every send silently no-ops and the
 * caller's flow continues — email is non-blocking for every flow that
 * uses it.
 */

const EMAIL_DOMAIN = process.env.EMAIL_DOMAIN ?? "gaznger.com";

/**
 * Sender registry — single source of truth for every `from` address.
 *
 * - `auth`: OTP, password reset, security alerts. Robotic, no-reply.
 * - `receipt`: Order receipts, payment confirmations. Robotic, no-reply
 *   but the body links to support@.
 * - `support`: Outbound human replies (rider/customer support agent
 *   responses). Reply-to lands in the support inbox.
 * - `marketing`: Promotions, weekly digests, points-balance nudges.
 *   Different identity so users can filter without blocking auth mail.
 * - `system`: Internal admin alerts, dispute notifications, vendor
 *   payout reports. Operator-facing.
 *
 * Each entry pairs a "name <addr>" RFC-compliant From string with an
 * optional reply-to (defaults to the same address when omitted).
 */
type EmailPurpose = "auth" | "receipt" | "support" | "marketing" | "system";

const SENDERS: Record<
  EmailPurpose,
  { from: string; replyTo?: string }
> = {
  auth: {
    from: `Gaznger <no-reply@${EMAIL_DOMAIN}>`,
    replyTo: `support@${EMAIL_DOMAIN}`,
  },
  receipt: {
    from: `Gaznger Orders <receipts@${EMAIL_DOMAIN}>`,
    replyTo: `support@${EMAIL_DOMAIN}`,
  },
  support: {
    from: `Gaznger Support <support@${EMAIL_DOMAIN}>`,
  },
  marketing: {
    from: `Gaznger <hello@${EMAIL_DOMAIN}>`,
    replyTo: `support@${EMAIL_DOMAIN}`,
  },
  system: {
    from: `Gaznger Alerts <alerts@${EMAIL_DOMAIN}>`,
    replyTo: `admin@${EMAIL_DOMAIN}`,
  },
};

let _resend: Resend | null = null;
function getResend(): Resend | null {
  if (!process.env.RESEND_API_KEY) return null;
  if (_resend) return _resend;
  _resend = new Resend(process.env.RESEND_API_KEY);
  return _resend;
}

interface SendArgs {
  to: string | string[];
  subject: string;
  html: string;
  /** Optional override of the registry's reply-to. */
  replyTo?: string;
}

/**
 * Generic, purpose-typed sender. All higher-level helpers below funnel
 * through this so the From-address policy stays in one place.
 */
async function sendEmail(purpose: EmailPurpose, args: SendArgs): Promise<void> {
  const resend = getResend();
  if (!resend) return; // No key — silently skip.
  const sender = SENDERS[purpose];
  try {
    await resend.emails.send({
      from: sender.from,
      to: args.to,
      subject: args.subject,
      html: args.html,
      replyTo: args.replyTo ?? sender.replyTo,
    });
  } catch {
    // Email send failed — every caller's flow is non-blocking.
  }
}

// ── Purpose-specific helpers ───────────────────────────────────────────────

export const sendOtpEmail = (email: string, otp: string) =>
  sendEmail("auth", {
    to: email,
    subject: "Your Gaznger Verification Code",
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto;">
        <h2>Gaznger Email Verification</h2>
        <p>Your verification code is:</p>
        <h1 style="letter-spacing: 8px; font-size: 40px;">${otp}</h1>
        <p>This code expires in 10 minutes.</p>
        <p>If you didn't request this, you can ignore this email.</p>
      </div>
    `,
  });

/**
 * Generic auth-channel send (password reset, suspicious-login alert,
 * etc.). Use when there's no dedicated helper yet.
 */
export const sendAuthEmail = (args: SendArgs) => sendEmail("auth", args);

/**
 * Order receipts, payment confirmations, withdrawal notifications.
 */
export const sendReceiptEmail = (args: SendArgs) => sendEmail("receipt", args);

/**
 * Outbound from the support team (responses to user tickets).
 */
export const sendSupportEmail = (args: SendArgs) => sendEmail("support", args);

/**
 * Marketing — points expiry warnings, promo announcements. ALWAYS
 * gated on the user's `preferences.promotions` flag at the call site.
 */
export const sendMarketingEmail = (args: SendArgs) =>
  sendEmail("marketing", args);

/**
 * Internal alerts — dispute opened, large withdrawal, fraud signal.
 */
export const sendSystemEmail = (args: SendArgs) => sendEmail("system", args);
