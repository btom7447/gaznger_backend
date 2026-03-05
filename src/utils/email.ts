import { Resend } from "resend";

const resend = new Resend(process.env.RESEND_API_KEY);

export const sendOtpEmail = async (email: string, otp: string) => {
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
