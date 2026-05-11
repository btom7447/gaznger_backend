import { Resend } from "resend";

/**
 * Lazy Resend singleton.
 *
 * The Resend SDK throws synchronously inside its constructor when the
 * key is falsy ("Missing API key. Pass it to the constructor `new
 * Resend(\"re_123\")`"). Instantiating at module-load — as the original
 * code did — caused the entire server to fail to boot whenever
 * `RESEND_API_KEY` was unset, which we don't want during early Railway
 * deploys (Resend is optional for the order flow). Defer construction
 * until the first send and short-circuit when the key is missing.
 */
let _resend: Resend | null = null;
function getResend(): Resend | null {
  if (!process.env.RESEND_API_KEY) return null;
  if (_resend) return _resend;
  _resend = new Resend(process.env.RESEND_API_KEY);
  return _resend;
}

export const sendOtpEmail = async (email: string, otp: string) => {
  const resend = getResend();
  if (!resend) return; // No key — silently skip; OTP still goes via WA/dev OTP.
  try {
    await resend.emails.send({
      from: "Gaznger <onboarding@resend.dev>",
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
  } catch {
    // Email send failed — order flow is not blocked by this
  }
};
